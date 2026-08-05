import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DispatchStatus } from '../common/enums';
import { WhatsAppDispatch } from './entities';
import { TemplatesService } from './templates/templates.service';
import { WebhookSignatureService } from './webhook-signature.service';

const AUDIT_TABLE_DISPATCHES = 'whatsapp_dispatches';
const AUDIT_ACTION_DISPATCH_STATUS_CHANGED = 'whatsapp_dispatch.status_changed';

/**
 * Effective dispatch transitions driven by the webhook (design §9.3 item 1,
 * spec "Webhook Status and Inbound Processing"). ONLY the forward edges
 * sent→delivered, sent→failed and delivered→read are effective; duplicates
 * (e.g. a repeated delivered) and regressions (e.g. a late sent after
 * delivered) must be ignored with no audit — AD6. Pure — no side effects.
 */
export function isEffectiveDispatchTransition(
  current: DispatchStatus,
  incoming: DispatchStatus,
): boolean {
  return (
    (current === DispatchStatus.SENT &&
      (incoming === DispatchStatus.DELIVERED || incoming === DispatchStatus.FAILED)) ||
    (current === DispatchStatus.DELIVERED && incoming === DispatchStatus.READ)
  );
}

/**
 * Maps the Meta status string from a webhook statuses[] entry to the dispatch
 * enum. Unknown values (deleted, rejected, …) return null so the webhook
 * answers 200 no-op. Pure — no side effects.
 */
export function mapProviderStatusToDispatchStatus(
  providerStatus: string,
): DispatchStatus | null {
  switch (providerStatus) {
    case DispatchStatus.SENT:
      return DispatchStatus.SENT;
    case DispatchStatus.DELIVERED:
      return DispatchStatus.DELIVERED;
    case DispatchStatus.READ:
      return DispatchStatus.READ;
    case DispatchStatus.FAILED:
      return DispatchStatus.FAILED;
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface WebhookChange {
  field?: string;
  value?: unknown;
}

interface WebhookEntry {
  changes?: WebhookChange[];
}

interface WebhookPayload {
  entry?: WebhookEntry[];
  [key: string]: unknown;
}

/**
 * Public webhook processing (design §9.3, tasks 4.3–4.4). GET handshake with
 * constant-time verify_token; POST verify-then-parse (AD3): the signature is
 * checked over the EXACT raw bytes BEFORE anything is parsed or persisted —
 * a missing/mismatched header answers 401/403 and touches nothing. All valid
 * business paths answer 200 fast; duplicates, regressions, unknown wamids and
 * unknown templates are silent no-ops (AD6) and every effective change audits
 * `whatsapp_dispatch.status_changed` / `whatsapp_template.status_changed`
 * with userId null (system event, AD9).
 */
@Injectable()
export class WebhookService {
  constructor(
    private readonly signatureService: WebhookSignatureService,
    private readonly templatesService: TemplatesService,
    @InjectRepository(WhatsAppDispatch)
    private readonly dispatchRepository: Repository<WhatsAppDispatch>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * GET handshake (design §9.3): hub.mode=subscribe + valid verify_token →
   * the hub.challenge as plain text; missing params → 400; a non-subscribe
   * mode or a mismatching verify_token → 403.
   */
  verifyHandshake(
    mode: string | undefined,
    verifyToken: string | undefined,
    challenge: string | undefined,
  ): string {
    if (
      mode === undefined ||
      verifyToken === undefined ||
      challenge === undefined
    ) {
      throw new BadRequestException('Missing handshake parameters');
    }
    if (mode !== 'subscribe' || !this.signatureService.verifyVerifyToken(verifyToken)) {
      throw new ForbiddenException('Invalid verify token');
    }
    return challenge;
  }

  /**
   * POST processing. Signature gate FIRST (AD3): missing header → 401,
   * mismatched → 403, with no parsing, persistence, or business data. Valid
   * requests are parsed and dispatched by payload shape (§9.3): statuses[],
   * messages[] (inbound seam) and message_template_status_update[].
   */
  async handlePost(
    rawBody: Buffer | undefined,
    signatureHeader: string | undefined,
  ): Promise<void> {
    const appSecret =
      this.configService.get<string>('WHATSAPP_APP_SECRET') ?? '';
    const signatureValid =
      rawBody !== undefined &&
      this.signatureService.verifyBodySignature(rawBody, signatureHeader, appSecret);
    if (!signatureValid) {
      if (!signatureHeader) {
        throw new UnauthorizedException('Missing webhook signature');
      }
      throw new ForbiddenException('Invalid webhook signature');
    }

    const payload = this.parsePayload(rawBody);
    await this.processStatuses(this.collectArray(payload, 'statuses'));
    this.processInboundSeam(this.collectArray(payload, 'messages'));
    await this.processTemplateStatusUpdates(payload);
  }

  private parsePayload(rawBody: Buffer): WebhookPayload {
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      if (!isRecord(parsed)) {
        throw new Error('payload is not an object');
      }
      return parsed as WebhookPayload;
    } catch {
      // Malformed body: nothing parsed, nothing persisted (AD3 fail closed).
      throw new BadRequestException('Invalid webhook payload');
    }
  }

  /**
   * Collects `statuses`/`messages` entries from BOTH supported payload
   * shapes: the flat design reading (`statuses[]` / `messages[]` at the
   * payload root, design §9.3) and the canonical Meta shape
   * (`entry[].changes[].field === 'messages'` → `value.statuses` /
   * `value.messages`).
   */
  private collectArray(payload: WebhookPayload, key: 'statuses' | 'messages'): unknown[] {
    const collected: unknown[] = [];
    const flat = payload[key];
    if (Array.isArray(flat)) {
      collected.push(...flat);
    }
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        if (isRecord(value) && Array.isArray(value[key])) {
          collected.push(...(value[key] as unknown[]));
        }
      }
    }
    return collected;
  }

  /**
   * Status updates (design §9.3 item 1): per entry by wamid, find the
   * dispatch by provider_message_id; unknown wamid → 200 no-op. An EFFECTIVE
   * transition only (sent→delivered, sent→failed, delivered→read) runs a TX
   * { UPDATE + audit whatsapp_dispatch.status_changed }; duplicates and
   * regressions are 200 no-ops with no audit (AD6). Audit payloads carry only
   * operational fields with userId null (system event, AD9).
   */
  private async processStatuses(statuses: unknown[]): Promise<void> {
    for (const status of statuses) {
      if (!isRecord(status)) continue;
      const wamid = status['id'];
      const providerStatus = status['status'];
      if (typeof wamid !== 'string' || typeof providerStatus !== 'string') {
        continue;
      }
      const incoming = mapProviderStatusToDispatchStatus(providerStatus);
      if (incoming === null) continue;

      const dispatch = await this.dispatchRepository.findOne({
        where: { providerMessageId: wamid },
      });
      if (!dispatch) continue;
      if (!isEffectiveDispatchTransition(dispatch.status, incoming)) continue;

      await this.dataSource.transaction(async (manager) => {
        const previousStatus = dispatch.status;
        dispatch.status = incoming;
        const saved = await manager.save(dispatch);
        await this.logDispatchStatusChangedAudit(manager, saved, previousStatus);
      });
    }
  }

  /**
   * Inbound message seam (task 4.3 re-scope, Phase 5): `bot.service` does not
   * exist yet (task 5.4), so the webhook answers 200 fast and persists
   * nothing. When 5.4 lands this hook is replaced with
   * `botService.processInbound(waId, messageId, body, timestamp)` (design
   * §9.3 item 2 / §9.4); inbound duplicate-delivery dedupe (bot_messages
   * provider_message_id UNIQUE) is covered by the 5.5 bot spec — this slice
   * creates NO bot entities.
   */
  private processInboundSeam(messages: unknown[]): void {
    // TODO(5.4): wire bot.service.processInbound — see tasks.md 4.3 re-scope note.
    void messages;
  }

  /**
   * Template status mirroring (design §9.3 item 3): the raw provider event is
   * handed to TemplatesService.mirrorProviderStatus (task 4.3 re-scope —
   * minimal contract, NOT the full 2.4 lifecycle scope). The method never
   * throws: unknown events, unknown templates and regressions are no-ops, so
   * this path always answers 200.
   */
  private async processTemplateStatusUpdates(payload: WebhookPayload): Promise<void> {
    const updates: Record<string, unknown>[] = [];
    const flat = payload['message_template_status_update'];
    if (Array.isArray(flat)) {
      for (const update of flat) {
        if (isRecord(update)) updates.push(update);
      }
    }
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== 'message_template_status_update') continue;
        if (isRecord(change.value)) updates.push(change.value);
      }
    }

    for (const update of updates) {
      const providerTemplateId = update['message_template_id'] ?? update['id'];
      const event = update['event'];
      if (typeof providerTemplateId !== 'string' || typeof event !== 'string') {
        continue;
      }
      await this.templatesService.mirrorProviderStatus(providerTemplateId, event);
    }
  }

  private async logDispatchStatusChangedAudit(
    manager: EntityManager,
    dispatch: WhatsAppDispatch,
    previousStatus: DispatchStatus,
  ): Promise<void> {
    await this.auditService.log(manager, {
      userId: null,
      action: AUDIT_ACTION_DISPATCH_STATUS_CHANGED,
      tableName: AUDIT_TABLE_DISPATCHES,
      recordId: dispatch.id,
      previousData: { status: previousStatus },
      newData: {
        status: dispatch.status,
        providerMessageId: dispatch.providerMessageId,
      },
    });
  }
}
