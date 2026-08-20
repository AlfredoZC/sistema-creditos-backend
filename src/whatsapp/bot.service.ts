import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  BotConversationState,
  BotDirection,
  TemplateCategory,
  TemplateStatus,
} from '../common/enums';
import { extractPlaceholderNumbers } from './dispatches.service';
import { BotConversation, BotMessage, MessageTemplate } from './entities';
import { parseIntent, BotIntent } from './intent-parser';
import { normalizePhone, phoneMatchesLeftNormalized } from './phone-normalizer';
import { truncateErrorMessage } from './provider/provider-errors';
import { WHATSAPP_PROVIDER } from './provider/whatsapp-provider.token';
import {
  SendTemplateMessageInput,
  WhatsAppProvider,
} from './provider/whatsapp-provider.interface';
import {
  PatientDebtSummary,
  PaymentPlansService,
} from '../payment-plans/payment-plans.service';

const CSW_WINDOW_MS = 24 * 60 * 60 * 1000;
const LOCKOUT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_IDENTIFICATION_ATTEMPTS = 3;

const AUDIT_TABLE_CONVERSATIONS = 'bot_conversations';
const AUDIT_TABLE_MESSAGES = 'bot_messages';
const AUDIT_ACTION_CONVERSATION_STARTED = 'bot_conversation.started';
const AUDIT_ACTION_CONVERSATION_IDENTIFIED = 'bot_conversation.identified';
const AUDIT_ACTION_CONVERSATION_IDENTIFICATION_FAILED =
  'bot_conversation.identification_failed';
const AUDIT_ACTION_MESSAGE_RECEIVED = 'bot_message.received';
const AUDIT_ACTION_MESSAGE_SENT = 'bot_message.sent';

const NO_DISPATCHABLE_UTILITY_TEMPLATE_ERROR =
  'no_dispatchable_utility_template';

/**
 * The provider port (AD1) exposes ONLY sendTemplate; free-form replies are
 * therefore represented as template sends under this reserved marker name,
 * with the reply body as variable `1` (design §9.4 step 6 routes EVERY reply
 * through provider.sendTemplate). With the Meta adapter this surfaces as a
 * provider failure recorded in the reply metadata — the design's own
 * fallback (the meta adapter has no raw-text path in this change).
 */
export const FREE_FORM_TEXT_SEND_TEMPLATE_NAME = 'bot_text_reply';

export const MENU_REPLY_TEXT =
  'Elige una opción: escribe SALDO para conocer tu saldo, CUOTAS para ver tu próxima cuota, o PROXIMA para la fecha de tu próxima cuota.';
export const REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT =
  'Para verificar tu identidad, por favor envía tu número de cédula de identidad (CI).';
export const IDENTIFICATION_GUIDANCE_REPLY_TEXT =
  'Has superado el número máximo de intentos. Por favor, contacta a la clínica para verificar tu identidad.';

/**
 * Renders the free-form reply for a menu intent (design §9.4 step 5,
 * spec "Debt Query and Reply"): all money fields are decimal strings from
 * the patient-scoped debt read. Pure — no side effects.
 */
export function formatDebtIntentReply(
  summary: PatientDebtSummary,
  intent: BotIntent,
): string {
  const next = summary.nextDueInstallment;
  switch (intent) {
    case 'saldo':
      return (
        `Tu saldo pendiente es Bs ${summary.outstandingBalance}.` +
        (next
          ? ` Próxima cuota: Bs ${next.totalAmount} (vence el ${next.dueDate}).`
          : ' No tienes cuotas pendientes por vencer.') +
        ` Total vencido: Bs ${summary.overdueTotal}.`
      );
    case 'cuotas':
      return next
        ? `Tu próxima cuota es la número ${next.installmentNumber} por Bs ${next.totalAmount}, con vencimiento el ${next.dueDate}.`
        : 'No tienes cuotas pendientes por vencer.';
    case 'proxima':
      return next
        ? `La fecha de tu próxima cuota es el ${next.dueDate}.`
        : 'No tienes cuotas pendientes por vencer.';
  }
}

/**
 * Resolves the debt summary into template variables for the out-of-window
 * fallback (design §9.4 step 5). Convention: the summary fields are assigned
 * to the template's placeholders in ascending numeric order —
 * {{1}} = outstanding balance, {{2}} = next-due amount ('' when none),
 * {{3}} = next-due date ('' when none), {{4}} = overdue total; extra
 * placeholders resolve to ''. Pure — no side effects.
 */
export function resolveDebtTemplateVariables(
  summary: PatientDebtSummary,
  placeholderNumbers: number[],
): Record<string, string> {
  const values = [
    summary.outstandingBalance,
    summary.nextDueInstallment?.totalAmount ?? '',
    summary.nextDueInstallment?.dueDate ?? '',
    summary.overdueTotal,
  ];
  const variables: Record<string, string> = {};
  const sorted = [...placeholderNumbers].sort((a, b) => a - b);
  for (const [index, placeholder] of sorted.entries()) {
    variables[String(placeholder)] = values[index] ?? '';
  }
  return variables;
}

export interface BotInboundResult {
  /** true when the message entered the conversation flow; false for dedupe no-ops. */
  processed: boolean;
}

interface PatientCandidate {
  id: string;
  identityDocument: string;
  phone: string;
}

interface PgErrorCrate {
  code?: string;
  driverError?: { code?: string };
}

function isUniqueViolation(error: unknown): boolean {
  const crate = error as PgErrorCrate;
  return crate?.driverError?.code === '23505' || crate?.code === '23505';
}

/**
 * The inbound Meta `timestamp` (epoch seconds) IS the processing clock for
 * window/lockout decisions — deterministic without fake timers; missing or
 * invalid values fall back to now(). Pure — no side effects.
 */
function resolveProcessingTime(timestamp?: string | number): Date {
  const seconds = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000);
  }
  return new Date();
}

/**
 * Conversational debt bot (design §9.4, spec "Conversation Lifecycle" +
 * "Patient Identification" + "Debt Query and Reply"). Called per inbound
 * message by the webhook service; every path answers fast and the bot
 * message id dedupes duplicates (bot_messages.provider_message_id UNIQUE —
 * AD6). See the flow in design §10 (bot inbound sequence).
 *
 * Clock: `timestamp` (Meta epoch seconds) drives the CSW window (AD7) and the
 * lockout (finding 2) — see resolveProcessingTime.
 *
 * Audit discipline (AD8/AD9): every bot message row is persisted in the SAME
 * transaction as its audit entry (received for inbound, sent for outbound —
 * finding 3); audit newData carries ONLY operational fields (state,
 * patientId, direction, type, templateId, intent, failedAttempts) — never
 * wa_id, phones, identity documents, message bodies, or debt amounts. All
 * bot audits use userId null (system event, spec "Actor vs system
 * attribution").
 */
@Injectable()
export class BotService {
  constructor(
    @InjectRepository(BotConversation)
    private readonly conversationRepository: Repository<BotConversation>,
    @InjectRepository(BotMessage)
    private readonly messageRepository: Repository<BotMessage>,
    @InjectRepository(MessageTemplate)
    private readonly templateRepository: Repository<MessageTemplate>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly paymentPlansService: PaymentPlansService,
    @Inject(WHATSAPP_PROVIDER)
    private readonly provider: WhatsAppProvider,
  ) {}

  /**
   * processInbound(waId, messageId, body, timestamp) — design §9.4.
   *
   * 1. Dedupe: a bot_messages row with this provider_message_id already
   *    exists → silent no-op ({ processed: false }), the webhook answers 200.
   *    A racing duplicate that slips past the SELECT hits the UNIQUE
   *    constraint and is caught as a 23505 no-op at the same boundary.
   * 2. Find-or-create the conversation by the CANONICAL normalized wa_id
   *    (wa_id = normalizePhone(waId); the UNIQUE constraint guarantees at
   *    most one row per number). Creation audits bot_conversation.started
   *    with newData { state } — no wa_id (AD9 PII boundary).
   * 3. State machine per §9.4 step 3 with one TX per transition, then the
   *    reply pipeline of §9.4 step 6 (row+audit commit → provider → update).
   */
  async processInbound(
    waId: string,
    messageId: string,
    body: string,
    timestamp?: string | number,
  ): Promise<BotInboundResult> {
    try {
      return await this.processInboundInner(waId, messageId, body, timestamp);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Dedupe race on bot_messages.provider_message_id (or a lost
        // conversation-create race): a concurrent identical delivery already
        // persisted this message — silent 200 no-op (AD6).
        return { processed: false };
      }
      throw error;
    }
  }

  private async processInboundInner(
    waId: string,
    messageId: string,
    body: string,
    timestamp?: string | number,
  ): Promise<BotInboundResult> {
    const deduped = await this.messageRepository.findOne({
      where: { providerMessageId: messageId },
    });
    if (deduped) return { processed: false };

    const canonicalWaId = normalizePhone(waId);
    const processingTime = resolveProcessingTime(timestamp);

    let conversation = await this.conversationRepository.findOne({
      where: { waId: canonicalWaId },
    });
    if (!conversation) {
      try {
        conversation = await this.dataSource.transaction(async (manager) => {
          const created = manager.create(BotConversation, {
            waId: canonicalWaId,
            state: BotConversationState.UNIDENTIFIED,
            failedAttempts: 0,
          });
          const saved = await manager.save(created);
          await this.logStartedAudit(manager, saved);
          return saved;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // Lost a create race — reuse the winner.
        conversation = await this.conversationRepository.findOne({
          where: { waId: canonicalWaId },
        });
        if (!conversation) throw error;
      }
    }

    switch (conversation.state) {
      case BotConversationState.UNIDENTIFIED:
        await this.processUnidentified(
          conversation,
          canonicalWaId,
          messageId,
          body,
          processingTime,
        );
        break;
      case BotConversationState.AWAITING_DOCUMENT:
        await this.processAwaitingDocument(
          conversation,
          canonicalWaId,
          messageId,
          body,
          processingTime,
        );
        break;
      case BotConversationState.IDENTIFIED:
        await this.processIdentified(
          conversation,
          messageId,
          body,
          processingTime,
        );
        break;
    }
    return { processed: true };
  }

  /**
   * unidentified state (§9.4 step 3): exactly one phone candidate →
   * identified TX + menu; zero or multiple candidates → awaiting_document TX
   * + identity-document request. Candidates are matched with the canonical
   * indexed lookup (phone = canonical) PLUS a separator-insensitive fallback
   * (regexp_replace keeps digits only, so legacy '591XXXXXXXX' and spaced
   * '+591 7000-0001' forms match) — every returned row re-verified through
   * phoneMatchesLeftNormalized (design §6 lookup semantics).
   */
  private async processUnidentified(
    conversation: BotConversation,
    canonicalWaId: string,
    messageId: string,
    body: string,
    processingTime: Date,
  ): Promise<void> {
    const candidates = await this.findPhoneCandidates(canonicalWaId);

    if (candidates.length === 1) {
      const identified = await this.dataSource.transaction(async (manager) => {
        conversation.state = BotConversationState.IDENTIFIED;
        conversation.patientId = candidates[0].id;
        conversation.lastActivityAt = processingTime;
        const saved = await manager.save(conversation);
        await this.logIdentifiedAudit(manager, saved);
        await this.persistInboundMessage(manager, saved.id, messageId, body);
        return saved;
      });
      await this.sendTextReply(identified, MENU_REPLY_TEXT, null);
      return;
    }

    const awaiting = await this.dataSource.transaction(async (manager) => {
      conversation.state = BotConversationState.AWAITING_DOCUMENT;
      conversation.lastActivityAt = processingTime;
      const saved = await manager.save(conversation);
      await this.persistInboundMessage(manager, saved.id, messageId, body);
      return saved;
    });
    await this.sendTextReply(
      awaiting,
      REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT,
      null,
    );
  }

  /**
   * awaiting_document state (§9.4 step 3): active lockout → guidance re-sent
   * with NO attempt increment (spec "Soft lock after three failures"); an
   * expired lockout resets failed_attempts=0 + lockout_until=NULL FIRST
   * (finding 2 — the windowed max-3-per-24h, so CHECK 23514 is unreachable).
   * The body is verified against the phone-candidate patients (trim +
   * toUpperCase; every candidate's normalized phone matches the caller's
   * wa_id by construction of findPhoneCandidates). Any other outcome is a
   * failed attempt: 1..2 → re-request; 3 → lockout_until = now + 24h + audit
   * bot_conversation.identification_failed (newData { failedAttempts: 3 },
   * never the document) + clinic-contact guidance.
   */
  private async processAwaitingDocument(
    conversation: BotConversation,
    canonicalWaId: string,
    messageId: string,
    body: string,
    processingTime: Date,
  ): Promise<void> {
    if (
      conversation.lockoutUntil &&
      processingTime.getTime() < conversation.lockoutUntil.getTime()
    ) {
      const updated = await this.dataSource.transaction(async (manager) => {
        conversation.lastActivityAt = processingTime;
        const saved = await manager.save(conversation);
        await this.persistInboundMessage(manager, saved.id, messageId, body);
        return saved;
      });
      await this.sendTextReply(
        updated,
        IDENTIFICATION_GUIDANCE_REPLY_TEXT,
        null,
      );
      return;
    }

    if (conversation.lockoutUntil) {
      // Lockout expired: windowed counter resets before the attempt counts.
      conversation.failedAttempts = 0;
      conversation.lockoutUntil = null;
    }

    const candidates = await this.findPhoneCandidates(canonicalWaId);
    const normalizedBody = body.trim().toUpperCase();
    const matched = candidates.find(
      (candidate) =>
        candidate.identityDocument.toUpperCase() === normalizedBody,
    );

    if (matched) {
      const identified = await this.dataSource.transaction(async (manager) => {
        conversation.state = BotConversationState.IDENTIFIED;
        conversation.patientId = matched.id;
        conversation.failedAttempts = 0;
        conversation.lockoutUntil = null;
        conversation.lastActivityAt = processingTime;
        const saved = await manager.save(conversation);
        await this.logIdentifiedAudit(manager, saved);
        await this.persistInboundMessage(manager, saved.id, messageId, body);
        return saved;
      });
      await this.sendTextReply(identified, MENU_REPLY_TEXT, null);
      return;
    }

    const updated = await this.dataSource.transaction(async (manager) => {
      conversation.failedAttempts += 1;
      const lockedOut =
        conversation.failedAttempts >= MAX_IDENTIFICATION_ATTEMPTS;
      if (lockedOut) {
        conversation.lockoutUntil = new Date(
          processingTime.getTime() + LOCKOUT_WINDOW_MS,
        );
      }
      conversation.lastActivityAt = processingTime;
      const saved = await manager.save(conversation);
      await this.persistInboundMessage(manager, saved.id, messageId, body);
      if (lockedOut) {
        await this.logIdentificationFailedAudit(manager, saved.id);
      }
      return saved;
    });

    const replyText =
      updated.failedAttempts >= MAX_IDENTIFICATION_ATTEMPTS
        ? IDENTIFICATION_GUIDANCE_REPLY_TEXT
        : REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT;
    await this.sendTextReply(updated, replyText, null);
  }

  /**
   * identified state (§9.4 step 3–5): parse the intent, evaluate the CSW
   * window at processing START — BEFORE the inbound updates last_activity_at
   * (AD7) — persist the inbound message, then reply. In-window: free-form
   * text (intent answer or menu). Out-of-window: NO free-form — an
   * approved+active utility template via variables; when none exists nothing
   * is sent and the failure is recorded in the reply row metadata (spec Q1,
   * "Outside CSW template fallback").
   */
  private async processIdentified(
    conversation: BotConversation,
    messageId: string,
    body: string,
    processingTime: Date,
  ): Promise<void> {
    const intent = parseIntent(body);
    const windowOpen =
      processingTime.getTime() - conversation.lastActivityAt.getTime() <
      CSW_WINDOW_MS;

    const updated = await this.dataSource.transaction(async (manager) => {
      conversation.lastActivityAt = processingTime;
      const saved = await manager.save(conversation);
      await this.persistInboundMessage(manager, saved.id, messageId, body);
      return saved;
    });

    const summary = await this.paymentPlansService.getPatientDebtSummary(
      conversation.patientId!,
    );

    if (windowOpen) {
      const replyBody = intent
        ? formatDebtIntentReply(summary, intent)
        : MENU_REPLY_TEXT;
      await this.sendTextReply(updated, replyBody, intent);
      return;
    }

    const template = await this.findDispatchableUtilityTemplate();
    if (template) {
      await this.sendTemplateReply(updated, template, summary, intent);
      return;
    }

    const replyBody = intent
      ? formatDebtIntentReply(summary, intent)
      : MENU_REPLY_TEXT;
    // Nothing is sent (proposal Q1); the failure is recorded in the reply
    // row metadata. Type 'text' — the template_requires_template_type CHECK
    // forbids a 'template' row without a template_id.
    await this.persistReplyRow(updated, replyBody, intent, 'text', null, {
      status: 'failed',
      error: NO_DISPATCHABLE_UTILITY_TEMPLATE_ERROR,
    });
  }

  /**
   * Reply pipeline (design §9.4 step 6, finding 3): TX { outbound
   * bot_message row (type text|template, template_id when template, intent on
   * replies, metadata { status: 'pending' }) + audit bot_message.sent } →
   * COMMIT → provider.sendTemplate (AD5) → TX { provider_message_id +
   * status 'sent' } OR TX { status 'failed' + error }. The row and its audit
   * ALWAYS exist — a rollback removes both (spec "Message and audit
   * atomic").
   */
  private async sendTextReply(
    conversation: BotConversation,
    body: string,
    intent: BotIntent | null,
  ): Promise<void> {
    const replyId = await this.persistReplyRow(
      conversation,
      body,
      intent,
      'text',
      null,
      { status: 'pending' },
    );
    // The provider port has no raw-text send (AD1); the free-form reply is
    // delivered as a template send under the reserved marker name with the
    // body as variable 1 — the mock records it for assertions.
    const input: SendTemplateMessageInput = {
      to: conversation.waId,
      templateName: FREE_FORM_TEXT_SEND_TEMPLATE_NAME,
      language: 'es',
      variables: [{ name: '1', value: body }],
    };
    await this.deliverReply(conversation, replyId, input);
  }

  private async sendTemplateReply(
    conversation: BotConversation,
    template: MessageTemplate,
    summary: PatientDebtSummary,
    intent: BotIntent | null,
  ): Promise<void> {
    const placeholderNumbers = extractPlaceholderNumbers(template.bodyTemplate);
    const variables = resolveDebtTemplateVariables(summary, placeholderNumbers);
    const body = intent
      ? formatDebtIntentReply(summary, intent)
      : MENU_REPLY_TEXT;
    const replyId = await this.persistReplyRow(
      conversation,
      body,
      intent,
      'template',
      template.id,
      { status: 'pending' },
    );
    const input: SendTemplateMessageInput = {
      to: conversation.waId,
      templateName: template.name,
      language: template.language,
      variables: Object.entries(variables).map(([name, value]) => ({
        name,
        value,
      })),
    };
    await this.deliverReply(conversation, replyId, input);
  }

  private async deliverReply(
    conversation: BotConversation,
    replyId: string,
    input: SendTemplateMessageInput,
  ): Promise<void> {
    try {
      const result = await this.provider.sendTemplate(input);
      await this.dataSource.transaction(async (manager) => {
        const row = await manager.findOne(BotMessage, {
          where: { id: replyId },
        });
        if (!row) return;
        row.providerMessageId = result.providerMessageId;
        row.metadata = { ...row.metadata, status: 'sent' };
        await manager.save(row);
      });
    } catch (error) {
      await this.dataSource.transaction(async (manager) => {
        const row = await manager.findOne(BotMessage, {
          where: { id: replyId },
        });
        if (!row) return;
        row.metadata = {
          ...row.metadata,
          status: 'failed',
          error: truncateErrorMessage(
            error instanceof Error
              ? error.message
              : 'Unknown provider send failure',
          ),
        };
        await manager.save(row);
      });
    }
  }

  private async persistReplyRow(
    conversation: BotConversation,
    body: string,
    intent: BotIntent | null,
    type: 'text' | 'template',
    templateId: string | null,
    metadata: Record<string, unknown>,
  ): Promise<string> {
    return this.dataSource.transaction(async (manager) => {
      const message = manager.create(BotMessage, {
        conversationId: conversation.id,
        direction: BotDirection.OUTBOUND,
        body,
        providerMessageId: null,
        type,
        templateId,
        intent,
        metadata,
      });
      const saved = await manager.save(message);
      await this.logMessageSentAudit(manager, saved);
      return saved.id;
    });
  }

  /**
   * Persists one inbound message + its bot_message.received audit in the
   * caller's transaction (spec "Message and audit atomic"). newData carries
   * only { direction, type } — never the body or the wa_id (AD9).
   */
  private async persistInboundMessage(
    manager: EntityManager,
    conversationId: string,
    messageId: string,
    body: string,
  ): Promise<BotMessage> {
    const message = manager.create(BotMessage, {
      conversationId,
      direction: BotDirection.INBOUND,
      body,
      providerMessageId: messageId,
      type: 'text',
      intent: null,
      metadata: {},
    });
    const saved = await manager.save(message);
    await this.auditService.log(manager, {
      userId: null,
      action: AUDIT_ACTION_MESSAGE_RECEIVED,
      tableName: AUDIT_TABLE_MESSAGES,
      recordId: saved.id,
      newData: { direction: saved.direction, type: saved.type },
    });
    return saved;
  }

  /**
   * Phone candidates for a canonical wa_id (design §9.4 step 3): exact
   * indexed `phone = canonical` + separator-insensitive fallback over
   * digits-only. The fallback compares BOTH digit forms — with the country
   * code (`591XXXXXXXX`, stored canonical rows) and the bare national number
   * (`XXXXXXXX`, legacy raw rows) — so either storage convention matches a
   * canonical wa_id. Every returned row is re-verified through
   * phoneMatchesLeftNormalized so the lookup semantics match the shared
   * normalizer exactly.
   */
  private async findPhoneCandidates(
    canonicalPhone: string,
  ): Promise<PatientCandidate[]> {
    const digits = canonicalPhone.replace(/[^0-9]/g, '');
    const nationalDigits = digits.replace(/^591/, '');
    const rows = await this.dataSource.query(
      `SELECT id, identity_document AS "identityDocument", phone
         FROM patients
        WHERE phone = $1
           OR regexp_replace(phone, '[^0-9]', '', 'g') IN ($2, $3)`,
      [canonicalPhone, digits, nationalDigits],
    );
    return rows.filter((row) =>
      phoneMatchesLeftNormalized(row.phone, canonicalPhone),
    );
  }

  /**
   * Out-of-window fallback template (design §9.4 step 5): the latest
   * approved + active utility template — the reminder gate mirrors the
   * dispatch gate (dispatches.service requireDispatchableTemplate) restricted
   * to category 'utility' (design §9.1 note).
   */
  private findDispatchableUtilityTemplate(): Promise<MessageTemplate | null> {
    return this.templateRepository
      .createQueryBuilder('template')
      .where('template.category = :category', {
        category: TemplateCategory.UTILITY,
      })
      .andWhere('template.status = :status', {
        status: TemplateStatus.APPROVED,
      })
      .andWhere('template.is_active = :isActive', { isActive: true })
      .orderBy('template.created_at', 'DESC')
      .getOne();
  }

  private async logStartedAudit(
    manager: EntityManager,
    conversation: BotConversation,
  ): Promise<void> {
    await this.auditService.log(manager, {
      userId: null,
      action: AUDIT_ACTION_CONVERSATION_STARTED,
      tableName: AUDIT_TABLE_CONVERSATIONS,
      recordId: conversation.id,
      newData: { state: conversation.state },
    });
  }

  private async logIdentifiedAudit(
    manager: EntityManager,
    conversation: BotConversation,
  ): Promise<void> {
    await this.auditService.log(manager, {
      userId: null,
      action: AUDIT_ACTION_CONVERSATION_IDENTIFIED,
      tableName: AUDIT_TABLE_CONVERSATIONS,
      recordId: conversation.id,
      newData: {
        patientId: conversation.patientId,
        state: conversation.state,
      },
    });
  }

  private async logIdentificationFailedAudit(
    manager: EntityManager,
    conversationId: string,
  ): Promise<void> {
    await this.auditService.log(manager, {
      userId: null,
      action: AUDIT_ACTION_CONVERSATION_IDENTIFICATION_FAILED,
      tableName: AUDIT_TABLE_CONVERSATIONS,
      recordId: conversationId,
      // AD9: only the operational counter — never the attempted document.
      newData: { failedAttempts: MAX_IDENTIFICATION_ATTEMPTS },
    });
  }

  private async logMessageSentAudit(
    manager: EntityManager,
    message: BotMessage,
  ): Promise<void> {
    const newData: Record<string, unknown> = {
      direction: message.direction,
      type: message.type,
    };
    if (message.templateId) newData.templateId = message.templateId;
    if (message.intent) newData.intent = message.intent;
    await this.auditService.log(manager, {
      userId: null,
      action: AUDIT_ACTION_MESSAGE_SENT,
      tableName: AUDIT_TABLE_MESSAGES,
      recordId: message.id,
      newData,
    });
  }
}
