import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { WebhookService } from './webhook.service';

/**
 * Raw-body request: Nest is bootstrapped with `rawBody: true` (main.ts,
 * test-app.ts — design AD3) so `req.rawBody` carries the EXACT request bytes
 * the signature was computed over.
 */
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Public webhook controller (design §9.3, AD4): NO @Auth() — the app has no
 * global guard, so this controller is naturally JWT-excluded (same convention
 * as auth register/login and seed). Security comes from the signature gate in
 * WebhookService: GET is the verify-token handshake; POST verify-then-parses
 * and answers 200 fast on every valid/no-op business path.
 */
@ApiTags('WhatsApp Webhook')
@Controller(process.env.WHATSAPP_WEBHOOK_PATH ?? 'whatsapp/webhook')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  /**
   * Meta handshake: with hub.mode=subscribe and a verify_token matching
   * WHATSAPP_VERIFY_TOKEN (constant-time), echo hub.challenge as plain text;
   * missing params → 400; mismatch → 403.
   */
  @Get()
  @Header('Content-Type', 'text/plain')
  handshake(
    @Query('hub.mode') mode?: string,
    @Query('hub.verify_token') verifyToken?: string,
    @Query('hub.challenge') challenge?: string,
  ): string {
    return this.webhookService.verifyHandshake(mode, verifyToken, challenge);
  }

  /**
   * Verified webhook POST: the service verifies x-hub-signature-256 over the
   * raw bytes FIRST (missing header → 401, mismatch → 403, nothing parsed or
   * persisted), then processes statuses[]/messages[]/
   * message_template_status_update[] — always answering 200 fast.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async handlePost(@Req() req: RawBodyRequest): Promise<{ received: true }> {
    await this.webhookService.handlePost(
      req.rawBody,
      req.headers['x-hub-signature-256'] as string | undefined,
    );
    return { received: true };
  }
}
