import { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import * as request from 'supertest';

/**
 * Test client for signed webhook requests (tasks 4.2, consumed by the
 * webhook integration spec 4.5). Meta signs webhook POSTs as
 * `x-hub-signature-256: sha256=<hex(HMAC-SHA256(appSecret, rawBody))>`, so
 * the rawBody argument MUST be the EXACT bytes sent on the wire — callers
 * pass a JSON.stringify'd string or Buffer and sign the same value.
 */

export function computeHubSignature(
  appSecret: string,
  rawBody: string | Buffer,
): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

export function buildSignedWebhookPost(
  app: INestApplication,
  path: string,
  rawBody: string | Buffer,
  appSecret: string,
): request.Test {
  return request(app.getHttpServer())
    .post(path)
    .set('Content-Type', 'application/json')
    .set('x-hub-signature-256', computeHubSignature(appSecret, rawBody))
    .send(rawBody);
}

export function buildHandshakeGet(
  app: INestApplication,
  path: string,
  verifyToken: string,
  challenge = 'abc123',
): request.Test {
  return request(app.getHttpServer()).get(path).query({
    'hub.mode': 'subscribe',
    'hub.verify_token': verifyToken,
    'hub.challenge': challenge,
  });
}

/**
 * Test doubles from .env.test (loaded by test-utils/load-test-env.ts) so the
 * integration suite always signs with the same secret/token the specs assert
 * against. Loud failure instead of a silent empty-secret signature.
 */
export function getTestWebhookAppSecret(): string {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) {
    throw new Error(
      'WHATSAPP_APP_SECRET is not set — .env.test must define it (loaded by load-test-env).',
    );
  }
  return secret;
}

export function getTestWebhookVerifyToken(): string {
  const token = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!token) {
    throw new Error(
      'WHATSAPP_VERIFY_TOKEN is not set — .env.test must define it (loaded by load-test-env).',
    );
  }
  return token;
}
