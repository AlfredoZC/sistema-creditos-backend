import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createServer, IncomingHttpHeaders, Server } from 'http';
import { WebhookSignatureService } from '../whatsapp/webhook-signature.service';
import {
  buildHandshakeGet,
  buildSignedWebhookPost,
  computeHubSignature,
  getTestWebhookAppSecret,
  getTestWebhookVerifyToken,
} from './whatsapp-webhook-client';

/**
 * Self-test for the signed webhook test client (tasks 4.2): proves the
 * client computes signatures the server-side verifier accepts and that the
 * built supertest requests carry byte-exact bodies, the Meta header casing
 * (`x-hub-signature-256`) and the handshake query params. The main consumer
 * (webhook integration spec, task 4.5) lands in the next slice.
 */

const PINNED_APP_SECRET = 'test-app-secret';
const PINNED_RAW_BODY =
  '{"object":"whatsapp_business_account","entry":[{"id":"102290129340398","changes":[{"value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"16505551111","phone_number_id":"123456789"},"statuses":[{"id":"wamid.HBgLMTY1MDU1NTExMTEVAg","status":"delivered","timestamp":"1720000000","recipient_id":"16505551111"}]},"field":"messages"}]}]}';
const PINNED_EXPECTED_HEADER =
  'sha256=f1dd094719883e6eb4114cda9ea76ce05f8eb048bd4d94817fe5ae0512b7a66c';

interface CapturedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

function captureServer(): {
  server: Server;
  lastRequest: () => CapturedRequest | undefined;
} {
  let captured: CapturedRequest | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      captured = {
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  return { server, lastRequest: () => captured };
}

function appFor(server: Server): INestApplication {
  return { getHttpServer: () => server } as unknown as INestApplication;
}

function configServiceWith(
  env: Record<string, string | undefined>,
): ConfigService {
  return {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
}

describe('whatsapp-webhook-client (task 4.2 — signed test requests)', () => {
  it('computeHubSignature reproduces the PINNED vector committed in the signature spec', () => {
    expect(computeHubSignature(PINNED_APP_SECRET, PINNED_RAW_BODY)).toBe(
      PINNED_EXPECTED_HEADER,
    );
  });

  it('produces signatures the WebhookSignatureService accepts (valid, tampered, wrong secret)', () => {
    const service = new WebhookSignatureService(
      configServiceWith({ WHATSAPP_VERIFY_TOKEN: 'test-verify-token' }),
    );
    const rawBody = '{"object":"whatsapp_business_account","entry":[]}';

    const valid = computeHubSignature(PINNED_APP_SECRET, rawBody);
    expect(
      service.verifyBodySignature(Buffer.from(rawBody, 'utf8'), valid, PINNED_APP_SECRET),
    ).toBe(true);

    const tampered = computeHubSignature(PINNED_APP_SECRET, `${rawBody} `);
    expect(
      service.verifyBodySignature(Buffer.from(`${rawBody} `, 'utf8'), tampered, PINNED_APP_SECRET),
    ).toBe(true);
    // The same signature over the ORIGINAL bytes must be rejected.
    expect(
      service.verifyBodySignature(Buffer.from(rawBody, 'utf8'), tampered, PINNED_APP_SECRET),
    ).toBe(false);

    const wrongSecret = computeHubSignature('wrong-secret', rawBody);
    expect(
      service.verifyBodySignature(Buffer.from(rawBody, 'utf8'), wrongSecret, PINNED_APP_SECRET),
    ).toBe(false);
  });

  it('buildSignedWebhookPost sends the byte-exact body with the Meta x-hub-signature-256 header', async () => {
    const { server, lastRequest } = captureServer();
    const rawBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: '102290129340398', changes: [] }],
    });

    await buildSignedWebhookPost(
      appFor(server),
      '/whatsapp/webhook',
      rawBody,
      PINNED_APP_SECRET,
    ).expect(200);

    const captured = lastRequest();
    expect(captured).toBeDefined();
    expect(captured?.url).toBe('/whatsapp/webhook');
    expect(captured?.headers['x-hub-signature-256']).toBe(
      computeHubSignature(PINNED_APP_SECRET, rawBody),
    );
    expect(captured?.headers['content-type']).toContain('application/json');
    expect(captured?.body).toBe(rawBody); // byte-exact: the signature covers these bytes
  });

  it('buildHandshakeGet sends hub.mode, hub.verify_token and hub.challenge query params', async () => {
    const { server, lastRequest } = captureServer();

    await buildHandshakeGet(
      appFor(server),
      '/whatsapp/webhook',
      'test-verify-token',
      'abc123',
    ).expect(200);

    const captured = lastRequest();
    expect(captured).toBeDefined();
    expect(captured?.url).toContain('hub.mode=subscribe');
    expect(captured?.url).toContain('hub.verify_token=test-verify-token');
    expect(captured?.url).toContain('hub.challenge=abc123');
  });

  it('reads the test app secret and verify token from the loaded .env.test', () => {
    expect(getTestWebhookAppSecret()).toBe(PINNED_APP_SECRET);
    expect(getTestWebhookVerifyToken()).toBe('test-verify-token');
  });
});
