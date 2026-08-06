import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { WebhookSignatureService } from './webhook-signature.service';

/**
 * Unit spec for the webhook signature service (design §8, whatsapp-bot spec
 * "Webhook Contract: Handshake and Signature" unit layer). No DB, no HTTP:
 * pure constant-time HMAC verification over raw bytes.
 */

const PINNED_APP_SECRET = 'test-app-secret';
const PINNED_RAW_BODY =
  '{"object":"whatsapp_business_account","entry":[{"id":"102290129340398","changes":[{"value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"16505551111","phone_number_id":"123456789"},"statuses":[{"id":"wamid.HBgLMTY1MDU1NTExMTEVAg","status":"delivered","timestamp":"1720000000","recipient_id":"16505551111"}]},"field":"messages"}]}]}';
// Pinned literal: sha256=hex(HMAC-SHA256('test-app-secret', PINNED_RAW_BODY)),
// computed once with a node one-liner and committed so the algorithm is
// frozen — a change in algorithm, encoding or secret breaks this test.
const PINNED_EXPECTED_HEADER =
  'sha256=f1dd094719883e6eb4114cda9ea76ce05f8eb048bd4d94817fe5ae0512b7a66c';

function configServiceWith(
  env: Record<string, string | undefined>,
): ConfigService {
  return {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
}

describe('WebhookSignatureService (design §8 — handshake and signature)', () => {
  let service: WebhookSignatureService;

  beforeEach(() => {
    service = new WebhookSignatureService(
      configServiceWith({ WHATSAPP_VERIFY_TOKEN: 'test-verify-token' }),
    );
  });

  describe('verifyBodySignature', () => {
    it('accepts the PINNED vector: known secret + fixed raw body -> committed literal header', () => {
      expect(
        service.verifyBodySignature(
          Buffer.from(PINNED_RAW_BODY, 'utf8'),
          PINNED_EXPECTED_HEADER,
          PINNED_APP_SECRET,
        ),
      ).toBe(true);
    });

    it('accepts a self-computed vector over different inputs (algorithm stays honest)', () => {
      const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
      const header =
        'sha256=' +
        createHmac('sha256', 'another-secret').update(rawBody).digest('hex');

      expect(
        service.verifyBodySignature(
          Buffer.from(rawBody, 'utf8'),
          header,
          'another-secret',
        ),
      ).toBe(true);
    });

    it('rejects a tampered body whose header was signed over other bytes', () => {
      const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
      const header =
        'sha256=' +
        createHmac('sha256', PINNED_APP_SECRET).update(rawBody).digest('hex');

      expect(
        service.verifyBodySignature(
          Buffer.from(rawBody + ' '), // one extra byte after signing
          header,
          PINNED_APP_SECRET,
        ),
      ).toBe(false);
    });

    it('rejects a header signed with a different app secret', () => {
      const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
      const header =
        'sha256=' +
        createHmac('sha256', 'wrong-secret').update(rawBody).digest('hex');

      expect(
        service.verifyBodySignature(
          Buffer.from(rawBody, 'utf8'),
          header,
          PINNED_APP_SECRET,
        ),
      ).toBe(false);
    });

    it('returns false when the header is missing entirely', () => {
      expect(
        service.verifyBodySignature(
          Buffer.from(PINNED_RAW_BODY, 'utf8'),
          undefined,
          PINNED_APP_SECRET,
        ),
      ).toBe(false);
    });

    it('returns false for an empty header', () => {
      expect(
        service.verifyBodySignature(
          Buffer.from(PINNED_RAW_BODY, 'utf8'),
          '',
          PINNED_APP_SECRET,
        ),
      ).toBe(false);
    });

    it('returns false when the header hex has the wrong length (length pre-check)', () => {
      expect(
        service.verifyBodySignature(
          Buffer.from(PINNED_RAW_BODY, 'utf8'),
          'sha256=deadbeef', // too short to ever match a sha256 digest
          PINNED_APP_SECRET,
        ),
      ).toBe(false);
    });

    it('returns false for a wrong algorithm prefix', () => {
      const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
      const hex = createHmac('sha256', PINNED_APP_SECRET)
        .update(rawBody)
        .digest('hex');

      expect(
        service.verifyBodySignature(
          Buffer.from(rawBody, 'utf8'),
          `sha1=${hex}`, // sha256 hex under a sha1 prefix must not verify
          PINNED_APP_SECRET,
        ),
      ).toBe(false);
    });

    it('returns false without throwing for invalid hex in the header', () => {
      const rawBody = '{"object":"whatsapp_business_account","entry":[]}';
      const validHex = createHmac('sha256', PINNED_APP_SECRET)
        .update(rawBody)
        .digest('hex');

      // Same visible length but non-hex characters: must fail closed, not crash.
      const invalidHex = validHex.replace(/^.{8}/, 'zzzzzzzz');
      expect(
        service.verifyBodySignature(
          Buffer.from(rawBody, 'utf8'),
          `sha256=${invalidHex}`,
          PINNED_APP_SECRET,
        ),
      ).toBe(false);
    });
  });

  describe('verifyVerifyToken (constant-time vs WHATSAPP_VERIFY_TOKEN)', () => {
    it('accepts the exact configured token', () => {
      expect(service.verifyVerifyToken('test-verify-token')).toBe(true);
    });

    it('rejects a mismatched token', () => {
      expect(service.verifyVerifyToken('wrong-token')).toBe(false);
    });

    it('returns false when the token is missing', () => {
      expect(service.verifyVerifyToken(undefined)).toBe(false);
    });

    it('returns false when the token length differs (length pre-check)', () => {
      expect(service.verifyVerifyToken('short')).toBe(false);
    });

    it('returns false without throwing for same-length non-ASCII tokens', () => {
      // 'é' (2 utf8 bytes) vs 'e' (1 byte): same string length, different
      // buffer length — the guard must reject before timingSafeEqual.
      expect(service.verifyVerifyToken('é'.repeat(14))).toBe(false);
    });
  });
});
