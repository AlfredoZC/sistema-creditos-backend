import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { normalizePhone } from './phone-normalizer';
import { MockWhatsAppProvider } from './provider/mock-whatsapp-provider';
import { WHATSAPP_PROVIDER } from './whatsapp.module';
import {
  BotService,
  FREE_FORM_TEXT_SEND_TEMPLATE_NAME,
  IDENTIFICATION_GUIDANCE_REPLY_TEXT,
  MENU_REPLY_TEXT,
  REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT,
} from './bot.service';

jest.setTimeout(60000);

/**
 * Bot machinery spec (tasks 5.3–5.4, design §9.4). Proves the conversational
 * state machine end-to-end on db_creditos_test with the mock provider:
 * identification (single match / no match / multiple / document verify),
 * the 24h soft lockout incl. the post-expiry counter reset (finding 2),
 * the CSW window (AD7) with the utility-template fallback, the menu intents
 * against the real patient-scoped debt read, reply persistence + audit
 * atomicity (finding 3), the AD9 audit PII boundary, and inbound dedupe.
 *
 * CLOCK: processInbound(waId, messageId, body, timestamp) treats the Meta
 * inbound `timestamp` (epoch seconds) as the processing clock for window and
 * lockout decisions — deterministic without fake timers (the codebase has no
 * clock-injection convention; the design signature passes the timestamp in).
 *
 * The FULL 5.5 bot.spec (complete scenario coverage with the pinned debt
 * fixture 8155.19/1113.27/613.27 via the FinancingEngine) lands in the next
 * slice; this spec proves the machinery with a raw-SQL debt fixture that
 * produces the same pinned values.
 */

const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

/**
 * ISO 'YYYY-MM-DD' (UTC) `offsetDays` from today — keeps the pinned-debt
 * fixtures relative to the running clock so they never rot (the spec pin
 * used to be the fixed date 2026-08-05, which aged past the CSW window and
 * made installment 2 overdue). Mirrors todayUtcDateString() semantics.
 */
function isoDateFromToday(offsetDays: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** The next-due date used by every pinned-debt fixture/assertion below. */
const NEXT_DUE_DATE = isoDateFromToday(7);
const SURGERY_DATE = isoDateFromToday(30);

// patients.phone is UNIQUE (migration 002) and patient rows are shared with
// other suites on db_creditos_test — every insert needs a fresh phone.
function uniquePhone(): string {
  const pid3 = String(process.pid).slice(0, 3).padStart(3, '0');
  const ts2 = String(Date.now()).slice(-2);
  const seq2 = String(uniqueCounter++).slice(-2).padStart(2, '0');
  return `7${pid3}${ts2}${seq2}`;
}

// identity_document is varchar(20) and UNIQUE: pid + timestamp tail + counter.
function uniqueIdentityDocument(): string {
  return `DOC${RUN_SUFFIX.slice(-10)}${uniqueCounter++}`.toUpperCase();
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

interface IdRow {
  id: string;
}

interface ConversationRow {
  id: string;
  waId: string;
  state: string;
  patientId: string | null;
  failedAttempts: number;
  lockoutUntil: Date | null;
}

interface MessageRow {
  id: string;
  body: string;
  type: string;
  templateId: string | null;
  intent: string | null;
  providerMessageId: string | null;
  metadata: Record<string, unknown>;
}

interface AuditRow {
  action: string;
  userId: string | null;
  tableName: string;
  recordId: string;
  newData: Record<string, unknown> | null;
  previousData: Record<string, unknown> | null;
}

describe('BotService (tasks 5.3–5.4, design §9.4)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let botService: BotService;
  let auditService: AuditService;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    botService = app.get(BotService);
    auditService = app.get(AuditService);
    provider = app.get(WHATSAPP_PROVIDER) as MockWhatsAppProvider;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      `TRUNCATE TABLE bot_messages, bot_conversations, whatsapp_dispatches,
       message_templates RESTART IDENTITY CASCADE`,
    );
    provider.sent.length = 0;
    provider.submitted.length = 0;
    provider.failNext = false;
  });

  async function insertPatient(
    phone: string,
    identityDocument: string = uniqueIdentityDocument(),
  ): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Bot', 'Patient', $2) RETURNING id`,
      [identityDocument, phone],
    );
    return rows[0].id;
  }

  /**
   * A patient whose phone normalizes to a canonical +591 number with the
   * pinned debt state of payment-plans.spec (5.1): outstanding 8155.19,
   * next due = installment 2 (1113.27 on NEXT_DUE_DATE, relative to the run
   * clock), overdue 613.27.
   */
  async function insertDebtFixture(
    phone: string,
  ): Promise<{ patientId: string }> {
    const patientId = await insertPatient(phone);
    const catalogRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, base_cost)
       VALUES ($1, '8000.00') RETURNING id`,
      [`cat_${RUN_SUFFIX}_${uniqueCounter++}`],
    );
    const surgeryRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, $3, '9000.00') RETURNING id`,
      [patientId, catalogRows[0].id, SURGERY_DATE],
    );
    const planRows: IdRow[] = await dataSource.query(
      `INSERT INTO payment_plans
         (surgery_id, type, down_payment, financed_amount, monthly_interest_rate,
          installment_count, start_date, outstanding_balance, status)
       VALUES ($1, 'credit', '500.00', '8500.00', '2.00', 3, '2026-01-01',
               '8155.19', 'active') RETURNING id`,
      [surgeryRows[0].id],
    );
    const installments = [
      { number: 1, total: '1113.27', paid: '500.00', due: '2020-01-01', status: 'partial' },
      { number: 2, total: '1113.27', paid: '0.00', due: NEXT_DUE_DATE, status: 'pending' },
      { number: 3, total: '1113.27', paid: '0.00', due: '2999-01-01', status: 'pending' },
    ];
    for (const installment of installments) {
      await dataSource.query(
        `INSERT INTO installments
           (payment_plan_id, installment_number, principal_amount, interest_amount,
            total_amount, paid_amount, due_date, status)
         VALUES ($1, $2, '0.00', '0.00', $3, $4, $5, $6)`,
        [
          planRows[0].id,
          installment.number,
          installment.total,
          installment.paid,
          installment.due,
          installment.status,
        ],
      );
    }
    return { patientId };
  }

  async function insertApprovedUtilityTemplate(
    bodyTemplate: string,
  ): Promise<{ id: string; name: string }> {
    const rows: Array<{ id: string; name: string }> = await dataSource.query(
      `INSERT INTO message_templates (name, category, language, body_template, status, is_active)
       VALUES ($1, 'utility', 'es', $2, 'approved', true) RETURNING id, name`,
      [`util_${RUN_SUFFIX}_${uniqueCounter++}`, bodyTemplate],
    );
    return rows[0];
  }

  async function insertConversation(
    waId: string,
    state: string,
    overrides: {
      patientId?: string | null;
      failedAttempts?: number;
      lockoutUntil?: Date | null;
    } = {},
  ): Promise<ConversationRow> {
    const rows: ConversationRow[] = await dataSource.query(
      `INSERT INTO bot_conversations (wa_id, state, patient_id, failed_attempts, lockout_until)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, wa_id AS "waId", state, patient_id AS "patientId",
                 failed_attempts AS "failedAttempts", lockout_until AS "lockoutUntil"`,
      [
        waId,
        state,
        overrides.patientId ?? null,
        overrides.failedAttempts ?? 0,
        overrides.lockoutUntil ?? null,
      ],
    );
    return rows[0];
  }

  async function findConversation(waId: string): Promise<ConversationRow> {
    const rows: ConversationRow[] = await dataSource.query(
      `SELECT id, wa_id AS "waId", state, patient_id AS "patientId",
              failed_attempts AS "failedAttempts", lockout_until AS "lockoutUntil"
         FROM bot_conversations WHERE wa_id = $1`,
      [waId],
    );
    return rows[0];
  }

  async function outboundMessages(conversationId: string): Promise<MessageRow[]> {
    return dataSource.query(
      `SELECT id, body, type, template_id AS "templateId", intent,
              provider_message_id AS "providerMessageId", metadata
         FROM bot_messages
        WHERE conversation_id = $1 AND direction = 'outbound'
        ORDER BY created_at`,
      [conversationId],
    );
  }

  async function inboundCount(conversationId: string): Promise<number> {
    const rows: Array<{ count: string }> = await dataSource.query(
      `SELECT COUNT(*)::text AS count FROM bot_messages
        WHERE conversation_id = $1 AND direction = 'inbound'`,
      [conversationId],
    );
    return Number(rows[0].count);
  }

  async function auditsForRecordIds(recordIds: string[]): Promise<AuditRow[]> {
    if (recordIds.length === 0) return [];
    return dataSource.query(
      `SELECT action, user_id AS "userId", table_name AS "tableName",
              record_id AS "recordId", new_data AS "newData", previous_data AS "previousData"
         FROM audit_logs WHERE record_id = ANY($1) ORDER BY created_at`,
      [recordIds],
    );
  }

  /**
   * Two patients whose RAW phones normalize to the same canonical value —
   * forces the awaiting_document path so the identity-document verification
   * (spec "Correct document identifies") is exercised.
   */
  async function twoCandidatesFor(phone: string): Promise<{
    patientA: string;
    patientB: string;
    canonical: string;
  }> {
    const patientA = await insertPatient(phone);
    const patientB = await insertPatient(`+591${phone}`);
    return { patientA, patientB, canonical: normalizePhone(phone) };
  }

  async function identifiedWithDebt(): Promise<{
    conversationId: string;
    canonical: string;
    patientId: string;
  }> {
    const phone = uniquePhone();
    const { patientId } = await insertDebtFixture(phone);
    const canonical = normalizePhone(phone);
    await botService.processInbound(
      canonical,
      `wamid.bot.setup.${uniqueCounter++}`,
      'hola',
      nowSeconds(),
    );
    const conversation = await findConversation(canonical);
    return { conversationId: conversation.id, canonical, patientId };
  }

  describe('identification (unidentified state)', () => {
    it('identifies on a single phone match, persists the inbound message, and replies with the menu', async () => {
      const phone = uniquePhone();
      const patientId = await insertPatient(phone);
      const canonical = normalizePhone(phone);

      const result = await botService.processInbound(
        canonical,
        'wamid.bot.single.1',
        'hola',
        nowSeconds(),
      );
      expect(result.processed).toBe(true);

      const conversation = await findConversation(canonical);
      expect(conversation.state).toBe('identified');
      expect(conversation.patientId).toBe(patientId);
      expect(conversation.failedAttempts).toBe(0);

      const outbound = await outboundMessages(conversation.id);
      expect(outbound).toHaveLength(1);
      expect(outbound[0].body).toBe(MENU_REPLY_TEXT);
      expect(outbound[0].type).toBe('text');
      expect(outbound[0].intent).toBeNull();

      // The reply was sent through the provider after commit (AD5) — the
      // free-form send uses the reserved port marker (design §9.4 step 6).
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].input.to).toBe(canonical);
      expect(provider.sent[0].input.templateName).toBe(
        FREE_FORM_TEXT_SEND_TEMPLATE_NAME,
      );

      // Audits: conversation.started (creation) + identified, message.received
      // (inbound), message.sent (reply) — all with userId null (system).
      const inboundRows: Array<{ id: string }> = await dataSource.query(
        `SELECT id FROM bot_messages
          WHERE conversation_id = $1 AND direction = 'inbound'`,
        [conversation.id],
      );
      const audits = await auditsForRecordIds([
        conversation.id,
        ...inboundRows.map((row) => row.id),
        outbound[0].id,
      ]);
      const actions = audits.map((audit) => audit.action).sort();
      expect(actions).toEqual(
        [
          'bot_conversation.started',
          'bot_conversation.identified',
          'bot_message.received',
          'bot_message.sent',
        ].sort(),
      );
      for (const audit of audits) {
        expect(audit.userId).toBeNull();
      }
    });

    it('matches a legacy-format wa_id against the canonical patient phone (left-normalized lookup)', async () => {
      const phone = uniquePhone();
      await insertPatient(phone); // stored as the raw legacy 8-digit form
      const canonical = normalizePhone(phone);
      const digits = canonical.slice(4); // 8 national digits
      const spacedWaId = `+591 ${digits.slice(0, 4)}-${digits.slice(4)}`;

      const result = await botService.processInbound(
        spacedWaId,
        'wamid.bot.legacy.1',
        'hola',
        nowSeconds(),
      );

      expect(result.processed).toBe(true);
      const conversation = await findConversation(canonical);
      expect(conversation.state).toBe('identified');
    });

    it('enters awaiting_document and requests the identity document when no phone matches', async () => {
      const waId = '+59170009999';

      const result = await botService.processInbound(
        waId,
        'wamid.bot.nomatch.1',
        'hola',
        nowSeconds(),
      );
      expect(result.processed).toBe(true);

      const conversation = await findConversation(waId);
      expect(conversation.state).toBe('awaiting_document');
      expect(conversation.patientId).toBeNull();

      const outbound = await outboundMessages(conversation.id);
      expect(outbound[0].body).toBe(REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT);
      expect(provider.sent).toHaveLength(1);
    });

    it('enters awaiting_document when the phone matches more than one patient', async () => {
      const { canonical } = await twoCandidatesFor(uniquePhone());

      const result = await botService.processInbound(
        canonical,
        'wamid.bot.multi.1',
        'hola',
        nowSeconds(),
      );

      expect(result.processed).toBe(true);
      const conversation = await findConversation(canonical);
      expect(conversation.state).toBe('awaiting_document');
      expect(conversation.patientId).toBeNull();
      const outbound = await outboundMessages(conversation.id);
      expect(outbound[0].body).toBe(REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT);
    });
  });

  describe('identity document verification (awaiting_document state)', () => {
    it('identifies when the document matches a phone candidate (case and whitespace insensitive)', async () => {
      const { patientA, canonical } = await twoCandidatesFor(uniquePhone());
      const document = `DOC${RUN_SUFFIX.slice(-6)}${uniqueCounter++}`.toUpperCase();
      // patientA already carries a generated document; re-insert with a known one.
      await dataSource.query(
        `UPDATE patients SET identity_document = $1 WHERE id = $2`,
        [document, patientA],
      );

      await botService.processInbound(
        canonical,
        'wamid.bot.doc.first.1',
        'hola',
        nowSeconds(),
      );
      const result = await botService.processInbound(
        canonical,
        'wamid.bot.doc.verify.1',
        `  ${document.toLowerCase()}  `,
        nowSeconds(),
      );
      expect(result.processed).toBe(true);

      const conversation = await findConversation(canonical);
      expect(conversation.state).toBe('identified');
      expect(conversation.patientId).toBe(patientA);
      expect(conversation.failedAttempts).toBe(0);
      expect(conversation.lockoutUntil).toBeNull();

      const outbound = await outboundMessages(conversation.id);
      expect(outbound[outbound.length - 1].body).toBe(MENU_REPLY_TEXT);
    });

    it('counts a wrong document as a failed attempt and re-requests it', async () => {
      const { canonical } = await twoCandidatesFor(uniquePhone());

      await botService.processInbound(
        canonical,
        'wamid.bot.fail.first.1',
        'hola',
        nowSeconds(),
      );
      await botService.processInbound(
        canonical,
        'wamid.bot.fail.wrong.1',
        'DOCUMENTO EQUIVOCADO',
        nowSeconds(),
      );

      const conversation = await findConversation(canonical);
      expect(conversation.state).toBe('awaiting_document');
      expect(conversation.failedAttempts).toBe(1);
      expect(conversation.lockoutUntil).toBeNull();

      const outbound = await outboundMessages(conversation.id);
      expect(outbound[outbound.length - 1].body).toBe(
        REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT,
      );
      const audits = await auditsForRecordIds([conversation.id]);
      expect(
        audits.some((audit) => audit.action === 'bot_conversation.identification_failed'),
      ).toBe(false);
    });

    it('locks the conversation after three failed attempts and sends clinic-contact guidance', async () => {
      const { canonical } = await twoCandidatesFor(uniquePhone());
      const before = nowSeconds();

      await botService.processInbound(canonical, 'wamid.bot.lock.1', 'hola', before);
      await botService.processInbound(
        canonical,
        'wamid.bot.lock.2',
        'INCORRECTO',
        before + 1,
      );
      await botService.processInbound(
        canonical,
        'wamid.bot.lock.3',
        'INCORRECTO',
        before + 2,
      );
      await botService.processInbound(
        canonical,
        'wamid.bot.lock.4',
        'INCORRECTO',
        before + 3,
      );

      const conversation = await findConversation(canonical);
      expect(conversation.failedAttempts).toBe(3);
      expect(conversation.lockoutUntil).not.toBeNull();
      // lockout_until ≈ now + 24h
      const lockoutMs = new Date(conversation.lockoutUntil!).getTime();
      expect(lockoutMs - (before + 3) * 1000).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(lockoutMs - (before + 3) * 1000).toBeLessThan(25 * 60 * 60 * 1000);

      const outbound = await outboundMessages(conversation.id);
      expect(outbound[outbound.length - 1].body).toBe(
        IDENTIFICATION_GUIDANCE_REPLY_TEXT,
      );

      // The identification_failed audit carries ONLY the operational counter
      // (AD9 — never the attempted document value).
      const audits = await auditsForRecordIds([conversation.id]);
      const failedAudits = audits.filter(
        (audit) => audit.action === 'bot_conversation.identification_failed',
      );
      expect(failedAudits).toHaveLength(1);
      expect(failedAudits[0].newData).toEqual({ failedAttempts: 3 });
    });

    it('ignores attempts during an active lockout: guidance re-sent, NO increment (spec "Soft lock after three failures")', async () => {
      const { canonical } = await twoCandidatesFor(uniquePhone());
      const conversation = await insertConversation(canonical, 'awaiting_document', {
        failedAttempts: 3,
        lockoutUntil: new Date(Date.now() + 60 * 60 * 1000),
      });

      const result = await botService.processInbound(
        canonical,
        'wamid.bot.locked.1',
        'DOCUMENTO CUALQUIERA',
        nowSeconds(),
      );
      expect(result.processed).toBe(true);

      const stored = await findConversation(canonical);
      expect(stored.failedAttempts).toBe(3);
      expect(stored.lockoutUntil).not.toBeNull();

      const outbound = await outboundMessages(conversation.id);
      expect(outbound[outbound.length - 1].body).toBe(
        IDENTIFICATION_GUIDANCE_REPLY_TEXT,
      );
      const audits = await auditsForRecordIds([conversation.id]);
      expect(
        audits.some((audit) => audit.action === 'bot_conversation.identification_failed'),
      ).toBe(false);
    });

    it('resets counters when the lockout expired, then counts the next failure as attempt 1 (finding 2 — CHECK 23514 unreachable)', async () => {
      const { canonical } = await twoCandidatesFor(uniquePhone());
      const conversation = await insertConversation(canonical, 'awaiting_document', {
        failedAttempts: 3,
        lockoutUntil: new Date(Date.now() - 60 * 60 * 1000), // expired
      });

      const result = await botService.processInbound(
        canonical,
        'wamid.bot.expired.1',
        'DOCUMENTO EQUIVOCADO',
        nowSeconds(),
      );
      expect(result.processed).toBe(true);

      const stored = await findConversation(canonical);
      // Reset FIRST (finding 2), then the wrong document counts as attempt 1:
      // failed_attempts is never > 3 while a lockout is active, so the
      // chk_bot_conversations_failed_attempts_range CHECK can never fire 500.
      expect(stored.failedAttempts).toBe(1);
      expect(stored.lockoutUntil).toBeNull();
      expect(stored.state).toBe('awaiting_document');

      const outbound = await outboundMessages(conversation.id);
      expect(outbound[outbound.length - 1].body).toBe(
        REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT,
      );
    });
  });

  describe('identified conversation — menu intents inside the CSW window', () => {
    it('answers saldo with the debt decimal strings and reuses the same conversation (spec "Existing conversation reused")', async () => {
      const { conversationId, canonical, patientId } = await identifiedWithDebt();

      await botService.processInbound(
        canonical,
        `wamid.bot.saldo.${uniqueCounter++}`,
        'saldo',
        nowSeconds(),
      );

      // One conversation row for the whole exchange.
      const conversations: Array<{ count: string }> = await dataSource.query(
        `SELECT COUNT(*)::text AS count FROM bot_conversations WHERE wa_id = $1`,
        [canonical],
      );
      expect(conversations[0].count).toBe('1');
      expect(patientId).toBeTruthy();

      const outbound = await outboundMessages(conversationId);
      const last = outbound[outbound.length - 1];
      expect(last.body).toContain('8155.19');
      expect(last.body).toContain('1113.27');
      expect(last.body).toContain(NEXT_DUE_DATE);
      expect(last.body).toContain('613.27');
      expect(last.intent).toBe('saldo');
      expect(last.type).toBe('text');

      // Reply pipeline (design §9.4 step 6): row+audit commit, provider call,
      // then the row is updated to 'sent' with the wamid.
      expect(last.metadata).toMatchObject({ status: 'sent' });
      expect(last.providerMessageId).toMatch(/^wamid\.mock\.\d+$/);
      const sentAudits = await auditsForRecordIds([last.id]);
      expect(sentAudits.some((a) => a.action === 'bot_message.sent')).toBe(true);
    });

    it('answers cuotas with the next-due installment detail', async () => {
      const { conversationId, canonical } = await identifiedWithDebt();

      await botService.processInbound(
        canonical,
        `wamid.bot.cuotas.${uniqueCounter++}`,
        'cuotas',
        nowSeconds(),
      );

      const outbound = await outboundMessages(conversationId);
      const last = outbound[outbound.length - 1];
      expect(last.body).toContain('1113.27');
      expect(last.body).toContain(NEXT_DUE_DATE);
      expect(last.body).toContain('número 2');
      expect(last.intent).toBe('cuotas');
    });

    it('answers proxima with the next-due date (diacritics normalized)', async () => {
      const { conversationId, canonical } = await identifiedWithDebt();

      await botService.processInbound(
        canonical,
        `wamid.bot.proxima.${uniqueCounter++}`,
        'próxima',
        nowSeconds(),
      );

      const outbound = await outboundMessages(conversationId);
      const last = outbound[outbound.length - 1];
      expect(last.body).toContain(NEXT_DUE_DATE);
      expect(last.intent).toBe('proxima');
    });

    it('replies with the menu for an unknown intent', async () => {
      const { conversationId, canonical } = await identifiedWithDebt();

      await botService.processInbound(
        canonical,
        `wamid.bot.unknown.${uniqueCounter++}`,
        'hola mundo',
        nowSeconds(),
      );

      const outbound = await outboundMessages(conversationId);
      const last = outbound[outbound.length - 1];
      expect(last.body).toBe(MENU_REPLY_TEXT);
      expect(last.intent).toBeNull();
    });

    it('answers saldo with the zero summary for a patient without a plan', async () => {
      const phone = uniquePhone();
      await insertPatient(phone);
      const canonical = normalizePhone(phone);
      await botService.processInbound(
        canonical,
        `wamid.bot.zero.${uniqueCounter++}`,
        'hola',
        nowSeconds(),
      );
      const conversation = await findConversation(canonical);

      await botService.processInbound(
        canonical,
        `wamid.bot.zero.saldo.${uniqueCounter++}`,
        'saldo',
        nowSeconds(),
      );

      const outbound = await outboundMessages(conversation.id);
      const last = outbound[outbound.length - 1];
      expect(last.body).toContain('0.00');
      expect(last.body).toContain('No tienes cuotas pendientes por vencer.');
    });
  });

  describe('CSW window and template fallback (AD7, spec "Outside CSW template fallback")', () => {
    it('sends only via an approved+active utility template out-of-window — never free-form', async () => {
      const { conversationId, canonical } = await identifiedWithDebt();
      const template = await insertApprovedUtilityTemplate(
        'Resumen: saldo {{1}}, vencido {{2}}',
      );
      // 25h of silence: the window must be evaluated BEFORE this inbound
      // updates last_activity_at (AD7).
      await dataSource.query(
        `UPDATE bot_conversations SET last_activity_at = now() - interval '25 hours' WHERE id = $1`,
        [conversationId],
      );

      await botService.processInbound(
        canonical,
        `wamid.bot.window.${uniqueCounter++}`,
        'cuotas',
        nowSeconds(),
      );

      const outbound = await outboundMessages(conversationId);
      const last = outbound[outbound.length - 1];
      expect(last.type).toBe('template');
      expect(last.templateId).toBe(template.id);
      expect(last.metadata).toMatchObject({ status: 'sent' });

      // The provider got the template send with the summary variables in
      // placeholder order ({{1}} = outstanding, {{2}} = next-due amount).
      const record = provider.sent[provider.sent.length - 1];
      expect(record.input.templateName).toBe(template.name);
      expect(record.input.variables).toEqual([
        { name: '1', value: '8155.19' },
        { name: '2', value: '1113.27' },
      ]);
    });

    it('records the failure in metadata and sends NOTHING when no utility template exists', async () => {
      const { conversationId, canonical } = await identifiedWithDebt();
      await dataSource.query(
        `UPDATE bot_conversations SET last_activity_at = now() - interval '25 hours' WHERE id = $1`,
        [conversationId],
      );
      const sentBefore = provider.sent.length;

      await botService.processInbound(
        canonical,
        `wamid.bot.window.no-template.${uniqueCounter++}`,
        'cuotas',
        nowSeconds(),
      );

      const outbound = await outboundMessages(conversationId);
      const last = outbound[outbound.length - 1];
      expect(last.type).toBe('text');
      expect(last.metadata).toMatchObject({
        status: 'failed',
        error: 'no_dispatchable_utility_template',
      });
      expect(provider.sent).toHaveLength(sentBefore);
    });

    it('sends free-form in-window even when a utility template exists', async () => {
      const { conversationId, canonical } = await identifiedWithDebt();
      await insertApprovedUtilityTemplate('Resumen {{1}}');

      await botService.processInbound(
        canonical,
        `wamid.bot.window.open.${uniqueCounter++}`,
        'saldo',
        nowSeconds(),
      );

      const outbound = await outboundMessages(conversationId);
      const last = outbound[outbound.length - 1];
      expect(last.type).toBe('text');
      expect(last.templateId).toBeNull();
      expect(last.body).toContain('8155.19');
      const record = provider.sent[provider.sent.length - 1];
      expect(record.input.templateName).toBe(FREE_FORM_TEXT_SEND_TEMPLATE_NAME);
    });
  });

  describe('reply pipeline: persistence, provider, and atomicity (design §9.4 step 6, finding 3)', () => {
    it('marks the outbound reply failed in metadata when the provider send fails', async () => {
      const { conversationId, canonical } = await identifiedWithDebt();
      provider.failNext = true;

      await botService.processInbound(
        canonical,
        `wamid.bot.fail-send.${uniqueCounter++}`,
        'saldo',
        nowSeconds(),
      );

      const outbound = await outboundMessages(conversationId);
      const last = outbound[outbound.length - 1];
      expect(last.metadata.status).toBe('failed');
      expect(last.providerMessageId).toBeNull();
      expect(String(last.metadata.error)).toContain('Mock provider forced failure');
    });

    it('rolls back the outbound message AND its audit together (message+audit atomicity)', async () => {
      const { conversationId, canonical } = await identifiedWithDebt();
      const inboundBefore = await inboundCount(conversationId);

      const originalLog = auditService.log; // capture BEFORE spying
      const auditSpy = jest.spyOn(auditService, 'log');
      auditSpy.mockImplementation(async (manager, entry) => {
        if (entry.action === 'bot_message.sent') {
          throw new Error('forced audit failure');
        }
        return originalLog.call(auditService, manager, entry);
      });
      try {
        await expect(
          botService.processInbound(
            canonical,
            `wamid.bot.atom.${uniqueCounter++}`,
            'saldo',
            nowSeconds(),
          ),
        ).rejects.toThrow('forced audit failure');
      } finally {
        auditSpy.mockRestore();
      }

      // The inbound message + its received audit committed (earlier TX)…
      expect(await inboundCount(conversationId)).toBe(inboundBefore + 1);
      // …but the outbound row and its bot_message.sent audit are gone: only
      // the setup menu reply from identifiedWithDebt() survives.
      const outbound = await outboundMessages(conversationId);
      expect(outbound).toHaveLength(1);
      const sentAudits = await auditsForRecordIds([
        ...outbound.map((message) => message.id),
      ]);
      expect(sentAudits).toHaveLength(1);
      // The provider was never called for the rolled-back reply.
      expect(provider.sent).toHaveLength(1);
    });
  });

  describe('audit PII boundary (AD9, spec "No PII in audit payloads")', () => {
    it('never stores wa_id, documents, message bodies, or debt amounts in audit payloads', async () => {
      const digits = uniquePhone();
      const { patientId } = await insertDebtFixture(digits);
      const documentB = uniqueIdentityDocument();
      const canonical = normalizePhone(digits);
      // A second candidate forces the awaiting_document path.
      await insertPatient(`+591${digits}`, documentB);
      // The fixture patient's real document — needed to reach the identified
      // state so the saldo reply renders the debt amounts.
      const patientRows: Array<{ identityDocument: string }> =
        await dataSource.query(
          `SELECT identity_document AS "identityDocument" FROM patients WHERE id = $1`,
          [patientId],
        );
      const documentA = patientRows[0].identityDocument;

      await botService.processInbound(canonical, 'wamid.bot.pii.1', 'hola', nowSeconds());
      await botService.processInbound(
        canonical,
        'wamid.bot.pii.2',
        'DOCUMENTO EQUIVOCADO',
        nowSeconds(),
      );
      await botService.processInbound(
        canonical,
        'wamid.bot.pii.3',
        documentA,
        nowSeconds(),
      );
      await botService.processInbound(
        canonical,
        'wamid.bot.pii.4',
        'saldo',
        nowSeconds(),
      );

      const conversation = await findConversation(canonical);
      const messageRows: Array<{ id: string }> = await dataSource.query(
        `SELECT id FROM bot_messages WHERE conversation_id = $1`,
        [conversation.id],
      );
      const audits = await auditsForRecordIds([
        conversation.id,
        ...messageRows.map((row) => row.id),
      ]);
      expect(audits.length).toBeGreaterThan(0);

      const serialized = JSON.stringify(
        audits.map((audit) => ({
          action: audit.action,
          newData: audit.newData,
          previousData: audit.previousData,
        })),
      );
      const sensitiveValues = [
        canonical, // wa_id / phone
        documentA, // identity documents (both candidates)
        documentB,
        'DOCUMENTO EQUIVOCADO', // wrong document body
        'hola', // inbound body
        '8155.19', // debt amounts
        '1113.27',
        '613.27',
        NEXT_DUE_DATE,
      ];
      for (const sensitive of sensitiveValues) {
        expect(serialized).not.toContain(sensitive);
      }
    });
  });

  describe('inbound dedupe (spec "Duplicate delivery ignored")', () => {
    it('returns a silent no-op for a duplicate message id: one bot_message row, one reply', async () => {
      const canonical = '+59170001111';

      const first = await botService.processInbound(
        canonical,
        'wamid.bot.dup.1',
        'hola',
        nowSeconds(),
      );
      expect(first.processed).toBe(true);

      const second = await botService.processInbound(
        canonical,
        'wamid.bot.dup.1',
        'hola',
        nowSeconds(),
      );
      expect(second.processed).toBe(false);

      const rows: Array<{ count: string }> = await dataSource.query(
        `SELECT COUNT(*)::text AS count FROM bot_messages
          WHERE provider_message_id = 'wamid.bot.dup.1'`,
      );
      expect(rows[0].count).toBe('1');
      expect(provider.sent).toHaveLength(1);
      // The conversation still exists for the original delivery.
      const conversation = await findConversation(canonical);
      expect(conversation.state).toBe('awaiting_document');
    });
  });
});
