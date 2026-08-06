import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Webhook signature verification (design §8, whatsapp-bot spec "Webhook
 * Contract: Handshake and Signature"). Verify-then-parse is MANDATORY for
 * the public webhook: every POST must prove it was signed by Meta with
 * WHATSAPP_APP_SECRET over the EXACT raw bytes (rawBody: true) before any
 * parsing happens — parse-first is a spoofing vector (AD3).
 *
 * Both comparisons are constant-time (crypto.timingSafeEqual) with a length
 * pre-check, and every failure path returns `false` (fail closed) instead of
 * throwing.
 */

const HUB_SIGNATURE_PREFIX = 'sha256=';
const HUB_SIGNATURE_ALGORITHM = 'sha256';

@Injectable()
export class WebhookSignatureService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Meta signs webhook payloads as `x-hub-signature-256: sha256=<hex>`,
   * where hex = HMAC-SHA256(appSecret, rawBody) over the raw request bytes.
   * Returns true only when the provided header matches the recomputed
   * signature in constant time; missing/empty/malformed headers return false.
   */
  verifyBodySignature(
    rawBody: Buffer,
    signatureHeader: string | undefined,
    appSecret: string,
  ): boolean {
    if (!signatureHeader || !signatureHeader.startsWith(HUB_SIGNATURE_PREFIX)) {
      return false;
    }

    const providedHex = signatureHeader.slice(HUB_SIGNATURE_PREFIX.length);
    const expectedHex = createHmac(HUB_SIGNATURE_ALGORITHM, appSecret)
      .update(rawBody)
      .digest('hex');

    return safeEqualHex(providedHex, expectedHex);
  }

  /**
   * Handshake verification: hub.verify_token must match WHATSAPP_VERIFY_TOKEN
   * in constant time (length pre-check first).
   */
  verifyVerifyToken(token: string | undefined): boolean {
    const expected = this.configService.get<string>('WHATSAPP_VERIFY_TOKEN');
    if (!token || !expected || token.length !== expected.length) {
      return false;
    }

    const tokenBuffer = Buffer.from(token, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (tokenBuffer.length !== expectedBuffer.length) {
      return false;
    }
    return timingSafeEqual(tokenBuffer, expectedBuffer);
  }
}

/**
 * Constant-time hex comparison that fails closed: invalid hex decodes to a
 * shorter buffer, which trips the buffer-length guard before timingSafeEqual
 * (which would throw on length mismatch).
 */
function safeEqualHex(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}
