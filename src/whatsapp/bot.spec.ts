import { uniqueMobile8 } from '../test-utils/unique-phone';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { PaymentType, UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import {
  buildSignedWebhookPost,
  getTestWebhookAppSecret,
} from '../test-utils/whatsapp-webhook-client';
import {
  FREE_FORM_TEXT_SEND_TEMPLATE_NAME,
  IDENTIFICATION_GUIDANCE_REPLY_TEXT,
  MENU_REPLY_TEXT,
  REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT,
} from './bot.service';
import { DispatchesService } from './dispatches.service';
import { normalizePhone } from './phone-normalizer';
import { MockWhatsAppProvider } from './provider/mock-whatsapp-provider';
import { WHATSAPP_PROVIDER } from './whatsapp.module';

jest.setTimeout(60000);

/**
 * WhatsApp bot FULL scenario spec (task 5.5, design §9.4). Proves the
 * proposal success criteria end-to-end through the SIGNED WEBHOOK HTTP path
 * (signature -> parse -> BotService -> DB -> mock provider):
 *
 *   - "Hybrid patient texts -> identified -> summary": a hybrid patient
 *     (user_id NULL) with debt built through the REAL FinancingEngine
 *     (payment-plans.spec hybridPatientWithPinnedDebt recipe: credit plan
 *     + partial office payment + direct SQL pins) texts the number, gets
 *     identified, and the saldo reply carries the EXACT pinned decimal
 *     strings "8155.19" / "1113.27" / "613.27" from the real debt read.
 *   - "duplicate webhook deliveries ignored": two deliveries of the same
 *     message id produce ONE bot_message row and ONE reply.
 *
 * Plus the full inbound identification matrix (single match, no match,
 * correct document), the windowed 24h soft lockout (3 failures -> lock ->
 * expiry -> next failure counts as attempt 1 — CHECK 23514 unreachable),
 * the CSW 24h template fallback, message+audit atomicity (rollback removes
 * both), actor-vs-system attribution, and the AD9 audit PII boundary.
 *
 * CLOCK: the Meta inbound `timestamp` (epoch seconds) is passed through the
 * webhook untouched (webhook.service processInboundMessages) and drives the
 * CSW-window and lockout decisions (bot.service resolveProcessingTime) — so
 * every time-dependent scenario is deterministic through the real HTTP path,
 * no fake timers.
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

const WEBHOOK_PATH = '/api/whatsapp/webhook';

// patients.phone is UNIQUE (migration 002) and patient rows are shared with
// other suites on db_creditos_test — every insert needs a fresh phone that
// normalizes to a canonical +591 number (8 digits starting with 6/7).
function uniquePhone(): string {
  // Delegado al helper compartido: los contadores por archivo colisionaban
  // entre suites al correr todo en un mismo proceso (--runInBand).
  return uniqueMobile8();
}

// identity_document is varchar(20) and UNIQUE: pid + timestamp tail + counter.
function uniqueIdentityDocument(): string {
  return `DOC${RUN_SUFFIX.slice(-10)}${uniqueCounter++}`.toUpperCase();
}

function emailFor(localPart: string): string {
  return `${localPart}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`;
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

describe('WhatsApp bot — full inbound scenario spec (task 5.5, design §9.4)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let auditService: AuditService;
  let dispatchesService: DispatchesService;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
    auditService = app.get(AuditService);
    dispatchesService = app.get(DispatchesService);
    provider = app.get(WHATSAPP_PROVIDER) as MockWhatsAppProvider;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // The whatsapp feature tables belong to this slice — truncated between
    // tests; shared tables (patients, users, payment_plans, audit_logs) are
    // NEVER truncated, so every insert uses unique data (shared convention).
    await dataSource.query(
      `TRUNCATE TABLE bot_messages, bot_conversations, whatsapp_dispatches,
       message_templates RESTART IDENTITY CASCADE`,
    );
    provider.sent.length = 0;
    provider.submitted.length = 0;
    provider.failNext = false;
  });

  // ---------------------------------------------------------------- users

  async function insertUserRaw(
    email: string,
    name: string,
    role: string,
  ): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id`,
      [email, 'hashed-password', name, role],
    );
    return rows[0].id;
  }

  async function officeUser(): Promise<{ id: string; token: string }> {
    const id = await insertUserRaw(
      emailFor(`office.bot.${uniqueCounter++}`),
      'Office Bot',
      UserRole.OFFICE,
    );
    return { id, token: jwtService.sign({ id }) };
  }

  // --------------------------------------------------------------- patients

  /** Hybrid patient (user_id NULL): raw 8-digit phone, normalized at lookup. */
  async function insertPatient(
    phone: string,
    identityDocument: string = uniqueIdentityDocument(),
  ): Promise<{ id: string; identityDocument: string }> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (user_id, identity_document, first_name, paternal_last_name, phone)
       VALUES (NULL, $1, 'Bot', 'Patient', $2) RETURNING id`,
      [identityDocument, phone],
    );
    return { id: rows[0].id, identityDocument };
  }

  /**
   * The hybridPatientWithPinnedDebt fixture recipe from payment-plans.spec
   * (5.1): the schedule is built through the REAL FinancingEngine (credit
   * plan 10 x 1113.27 @ 2%, start 2026-01-01), the delinquent state and the
   * overdue amount come from a partial office payment (500.00 on installment
   * 1 -> PARTIAL, overdue 613.27), and direct SQL pins fix the scenario due
   * dates and the tracked outstanding_balance column (design D4 — the read
   * never recomputes it). The bot asserts the EXACT decimal strings
   * "8155.19" / "1113.27" / "613.27" in the saldo reply.
   */
  async function hybridPatientWithPinnedDebt(): Promise<{
    patientId: string;
    canonical: string;
    identityDocument: string;
  }> {
    const office = await officeUser();
    const phone = uniquePhone();
    const { id: patientId, identityDocument } = await insertPatient(phone);

    const catalogResponse = await request(app.getHttpServer())
      .post('/api/surgery-catalog')
      .set('Authorization', `Bearer ${office.token}`)
      .send({
        name: `cat_${RUN_SUFFIX}_${uniqueCounter++}`,
        baseCost: '8000.00',
      });
    expect(catalogResponse.status).toBe(201);

    const surgeryResponse = await request(app.getHttpServer())
      .post('/api/surgeries')
      .set('Authorization', `Bearer ${office.token}`)
      .send({
        patientId,
        surgeryCatalogId: catalogResponse.body.id,
        scheduledDate: SURGERY_DATE,
        totalCost: '10000.00',
      });
    expect(surgeryResponse.status).toBe(201);
    const surgeryId = surgeryResponse.body.id as string;

    const planResponse = await request(app.getHttpServer())
      .post('/api/payment-plans')
      .set('Authorization', `Bearer ${office.token}`)
      .send({
        surgeryId,
        type: 'credit',
        monthlyInterestRate: '2.00',
        installmentCount: 10,
        startDate: '2026-01-01',
      });
    expect(planResponse.status).toBe(201);
    const planId = planResponse.body.id as string;

    const methodRows: IdRow[] = await dataSource.query(
      `SELECT id FROM payment_methods WHERE name = 'cash'`,
    );
    const installmentRows: IdRow[] = await dataSource.query(
      `SELECT id FROM installments
        WHERE payment_plan_id = $1 AND installment_number = 1`,
      [planId],
    );
    const paymentResponse = await request(app.getHttpServer())
      .post('/api/payments')
      .set('Authorization', `Bearer ${office.token}`)
      .send({
        paymentPlanId: planId,
        installmentId: installmentRows[0].id,
        paymentMethodId: methodRows[0].id,
        amount: '500.00',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });
    expect(paymentResponse.status).toBe(201);

    // Pin the scenario state deterministically (the suite shares
    // db_creditos_test and the clock moves): installment 1 stays PARTIAL and
    // overdue; installment 2 becomes the next due (NEXT_DUE_DATE, relative to
    // the run clock); the rest move far-future so only installment 1 is
    // overdue.
    await dataSource.query(
      `UPDATE installments SET due_date = '2020-01-01'
        WHERE payment_plan_id = $1 AND installment_number = 1`,
      [planId],
    );
    await dataSource.query(
      `UPDATE installments SET due_date = $2
        WHERE payment_plan_id = $1 AND installment_number = 2`,
      [planId, NEXT_DUE_DATE],
    );
    await dataSource.query(
      `UPDATE installments SET due_date = '2999-01-01'
        WHERE payment_plan_id = $1 AND installment_number >= 3`,
      [planId],
    );
    await dataSource.query(
      `UPDATE payment_plans SET outstanding_balance = '8155.19' WHERE id = $1`,
      [planId],
    );

    return { patientId, canonical: normalizePhone(phone), identityDocument };
  }

  // -------------------------------------------------------------- templates

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

  // -------------------------------------------------- identification setups

  /**
   * Two patients whose RAW phones normalize to the same canonical value —
   * forces the awaiting_document path so the identity-document verification
   * (spec "Correct document identifies") is exercised.
   */
  async function twoCandidatesFor(phone: string): Promise<{
    patientA: { id: string; identityDocument: string };
    canonical: string;
  }> {
    const patientA = await insertPatient(phone);
    await insertPatient(`+591${phone}`);
    return { patientA, canonical: normalizePhone(phone) };
  }

  // ------------------------------------------------------- webhook driving

  /** Signed webhook POST with the canonical Meta messages[] shape. */
  function deliverInbound(messages: unknown[]): request.Test {
    const rawBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test-waba-id',
          changes: [
            {
              field: 'messages',
              value: { messaging_product: 'whatsapp', messages },
            },
          ],
        },
      ],
    });
    return buildSignedWebhookPost(
      app,
      WEBHOOK_PATH,
      rawBody,
      getTestWebhookAppSecret(),
    );
  }

  function inboundMessage(
    from: string,
    id: string,
    body: string,
    timestamp: number,
  ): Record<string, unknown> {
    return {
      from,
      id,
      timestamp: String(timestamp),
      text: { body },
    };
  }

  // ------------------------------------------------------------ DB helpers

  async function findConversation(waId: string): Promise<ConversationRow> {
    const rows: ConversationRow[] = await dataSource.query(
      `SELECT id, wa_id AS "waId", state, patient_id AS "patientId",
              failed_attempts AS "failedAttempts", lockout_until AS "lockoutUntil"
         FROM bot_conversations WHERE wa_id = $1`,
      [waId],
    );
    return rows[0];
  }

  async function outboundMessages(
    conversationId: string,
  ): Promise<MessageRow[]> {
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

  describe('hybrid patient identification and saldo summary (proposal success criterion "Hybrid patient texts → identified → summary")', () => {
    it('identifies a hybrid patient (user_id NULL) on a single phone match and answers saldo with the pinned decimal strings', async () => {
      const t0 = nowSeconds();
      const { patientId, canonical } = await hybridPatientWithPinnedDebt();

      // The hybrid patient has NO web account (user_id NULL) — the exact
      // population this bot exists for.
      const patientRows: Array<{ userId: string | null }> =
        await dataSource.query(
          `SELECT user_id AS "userId" FROM patients WHERE id = $1`,
          [patientId],
        );
      expect(patientRows[0].userId).toBeNull();

      // First message: single phone match -> identified + menu.
      const first = await deliverInbound([
        inboundMessage(canonical, 'wamid.bot.spec.identify.1', 'hola', t0),
      ]);
      expect(first.status).toBe(200);

      const conversation = await findConversation(canonical);
      expect(conversation.state).toBe('identified');
      expect(conversation.patientId).toBe(patientId);
      expect(conversation.failedAttempts).toBe(0);
      expect(conversation.lockoutUntil).toBeNull();

      // Only ONE conversation row for the whole exchange (uq wa_id).
      const conversations: Array<{ count: string }> = await dataSource.query(
        `SELECT COUNT(*)::text AS count FROM bot_conversations WHERE wa_id = $1`,
        [canonical],
      );
      expect(conversations[0].count).toBe('1');

      // 'saldo' inside the CSW window (60s later): free-form reply with the
      // EXACT pinned decimal strings from the REAL debt read.
      const second = await deliverInbound([
        inboundMessage(canonical, 'wamid.bot.spec.saldo.1', 'saldo', t0 + 60),
      ]);
      expect(second.status).toBe(200);

      const outbound = await outboundMessages(conversation.id);
      const last = outbound[outbound.length - 1];
      expect(last.body).toBe(
        `Tu saldo pendiente es Bs 8155.19. Próxima cuota: Bs 1113.27 (vence el ${NEXT_DUE_DATE}). Total vencido: Bs 613.27.`,
      );
      expect(last.intent).toBe('saldo');
      expect(last.type).toBe('text');
      expect(last.templateId).toBeNull();
      expect(last.metadata).toMatchObject({ status: 'sent' });
      expect(last.providerMessageId).toMatch(/^wamid\.mock\.\d+$/);

      // The reply was delivered after commit via the free-form port marker
      // (design §9.4 step 6); the mock recorded it.
      expect(provider.sent).toHaveLength(2);
      expect(provider.sent[1].input.to).toBe(canonical);
      expect(provider.sent[1].input.templateName).toBe(
        FREE_FORM_TEXT_SEND_TEMPLATE_NAME,
      );
      expect(provider.sent[1].input.variables).toEqual([
        { name: '1', value: last.body },
      ]);

      // Audits: started + identified + received x2 + sent x2, ALL with
      // userId null (system events — spec "Actor vs system attribution").
      const messageRows: Array<{ id: string }> = await dataSource.query(
        `SELECT id FROM bot_messages WHERE conversation_id = $1`,
        [conversation.id],
      );
      const audits = await auditsForRecordIds([
        conversation.id,
        ...messageRows.map((row) => row.id),
      ]);
      expect(audits.map((audit) => audit.action).sort()).toEqual(
        [
          'bot_conversation.started',
          'bot_conversation.identified',
          'bot_message.received',
          'bot_message.received',
          'bot_message.sent',
          'bot_message.sent',
        ].sort(),
      );
      for (const audit of audits) {
        expect(audit.userId).toBeNull();
      }
    });

    it('requests the identity document when no patient phone matches the wa_id (spec "No match requests document")', async () => {
      // A canonical number that no patient owns (unique per run).
      const noMatchWaId = normalizePhone(uniquePhone());
      const t0 = nowSeconds();

      const response = await deliverInbound([
        inboundMessage(noMatchWaId, 'wamid.bot.spec.nomatch.1', 'hola', t0),
      ]);
      expect(response.status).toBe(200);

      const conversation = await findConversation(noMatchWaId);
      expect(conversation.state).toBe('awaiting_document');
      expect(conversation.patientId).toBeNull();
      expect(conversation.failedAttempts).toBe(0);

      const outbound = await outboundMessages(conversation.id);
      expect(outbound).toHaveLength(1);
      expect(outbound[0].body).toBe(REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].input.to).toBe(noMatchWaId);
      expect(provider.sent[0].input.templateName).toBe(
        FREE_FORM_TEXT_SEND_TEMPLATE_NAME,
      );
    });
  });

  describe('identity document verification (spec "Patient Identification")', () => {
    it('identifies on the correct document when the phone matches more than one patient (spec "Correct document identifies")', async () => {
      const t0 = nowSeconds();
      const { patientA, canonical } = await twoCandidatesFor(uniquePhone());

      const first = await deliverInbound([
        inboundMessage(canonical, 'wamid.bot.spec.doc.first.1', 'hola', t0),
      ]);
      expect(first.status).toBe(200);
      let conversation = await findConversation(canonical);
      expect(conversation.state).toBe('awaiting_document');

      // The correct document, sent with whitespace and lowercase (the
      // verification is trim + case-insensitive).
      const second = await deliverInbound([
        inboundMessage(
          canonical,
          'wamid.bot.spec.doc.verify.1',
          `  ${patientA.identityDocument.toLowerCase()}  `,
          t0 + 1,
        ),
      ]);
      expect(second.status).toBe(200);

      conversation = await findConversation(canonical);
      expect(conversation.state).toBe('identified');
      expect(conversation.patientId).toBe(patientA.id);
      expect(conversation.failedAttempts).toBe(0);
      expect(conversation.lockoutUntil).toBeNull();

      const outbound = await outboundMessages(conversation.id);
      expect(outbound[outbound.length - 1].body).toBe(MENU_REPLY_TEXT);
    });

    it('soft-locks after three failures and ignores further attempts: guidance re-sent, NO increment (spec "Soft lock after three failures")', async () => {
      const t0 = nowSeconds();
      const { canonical } = await twoCandidatesFor(uniquePhone());

      await deliverInbound([
        inboundMessage(canonical, 'wamid.bot.spec.lock.0', 'hola', t0),
      ]);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await deliverInbound([
          inboundMessage(
            canonical,
            `wamid.bot.spec.lock.${attempt}`,
            'DOCUMENTO EQUIVOCADO',
            t0 + attempt,
          ),
        ]);
        expect(response.status).toBe(200);
      }

      let conversation = await findConversation(canonical);
      expect(conversation.failedAttempts).toBe(3);
      expect(conversation.lockoutUntil).not.toBeNull();
      // lockout_until = 3rd failure time + 24h (windowed soft lockout).
      const lockoutMs = new Date(conversation.lockoutUntil!).getTime();
      expect(lockoutMs - (t0 + 3) * 1000).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(lockoutMs - (t0 + 3) * 1000).toBeLessThan(25 * 60 * 60 * 1000);
      let outbound = await outboundMessages(conversation.id);
      expect(outbound[outbound.length - 1].body).toBe(
        IDENTIFICATION_GUIDANCE_REPLY_TEXT,
      );

      // An attempt DURING the lockout: guidance re-sent, counters untouched,
      // no new identification_failed audit (still exactly one).
      const lockedResponse = await deliverInbound([
        inboundMessage(
          canonical,
          'wamid.bot.spec.lock.locked.1',
          'DOCUMENTO CUALQUIERA',
          t0 + 10,
        ),
      ]);
      expect(lockedResponse.status).toBe(200);
      conversation = await findConversation(canonical);
      expect(conversation.failedAttempts).toBe(3);
      expect(conversation.lockoutUntil).not.toBeNull();
      outbound = await outboundMessages(conversation.id);
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

    it('after lockout expiry the next failure counts as attempt 1 — windowed max-3-per-24h, CHECK 23514 unreachable', async () => {
      const t0 = nowSeconds();
      const { canonical } = await twoCandidatesFor(uniquePhone());

      await deliverInbound([
        inboundMessage(canonical, 'wamid.bot.spec.expire.0', 'hola', t0),
      ]);
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await deliverInbound([
          inboundMessage(
            canonical,
            `wamid.bot.spec.expire.${attempt}`,
            'DOCUMENTO EQUIVOCADO',
            t0 + attempt,
          ),
        ]);
      }
      let conversation = await findConversation(canonical);
      expect(conversation.failedAttempts).toBe(3);

      // 25h after the 3rd failure: the lockout has expired. The windowed
      // counter resets FIRST (finding 2), so the next failure counts as
      // attempt 1 — failed_attempts is never > 3 while a lockout is active.
      const lateResponse = await deliverInbound([
        inboundMessage(
          canonical,
          'wamid.bot.spec.expire.late.1',
          'DOCUMENTO EQUIVOCADO',
          t0 + 3 + 25 * 60 * 60,
        ),
      ]);
      expect(lateResponse.status).toBe(200);

      conversation = await findConversation(canonical);
      expect(conversation.failedAttempts).toBe(1);
      expect(conversation.lockoutUntil).toBeNull();
      expect(conversation.state).toBe('awaiting_document');

      const outbound = await outboundMessages(conversation.id);
      expect(outbound[outbound.length - 1].body).toBe(
        REQUEST_IDENTITY_DOCUMENT_REPLY_TEXT,
      );
    });
  });

  describe('CSW window fallback (AD7, spec "Outside CSW template fallback")', () => {
    it('after 24h of inactivity replies ONLY via an approved+active utility template — never free-form', async () => {
      const t0 = nowSeconds();
      const { canonical } = await hybridPatientWithPinnedDebt();
      const template = await insertApprovedUtilityTemplate(
        'Resumen: saldo {{1}}, vencido {{2}}',
      );

      // Identification at t0 (last_activity_at = t0, window open).
      const first = await deliverInbound([
        inboundMessage(canonical, 'wamid.bot.spec.window.0', 'hola', t0),
      ]);
      expect(first.status).toBe(200);

      // 'cuotas' 25h later: the window is evaluated BEFORE this inbound
      // updates last_activity_at (AD7) — closed, so NO free-form is allowed.
      const second = await deliverInbound([
        inboundMessage(
          canonical,
          'wamid.bot.spec.window.1',
          'cuotas',
          t0 + 25 * 60 * 60,
        ),
      ]);
      expect(second.status).toBe(200);

      const conversation = await findConversation(canonical);
      const outbound = await outboundMessages(conversation.id);
      const last = outbound[outbound.length - 1];
      expect(last.type).toBe('template');
      expect(last.templateId).toBe(template.id);
      expect(last.metadata).toMatchObject({ status: 'sent' });

      // The provider got the template send with the summary variables in
      // placeholder order ({{1}} = outstanding, {{2}} = next-due amount) —
      // the LAST recorded send is the template, never the free-form marker.
      expect(provider.sent).toHaveLength(2);
      const record = provider.sent[provider.sent.length - 1];
      expect(record.input.templateName).toBe(template.name);
      expect(record.input.templateName).not.toBe(
        FREE_FORM_TEXT_SEND_TEMPLATE_NAME,
      );
      expect(record.input.variables).toEqual([
        { name: '1', value: '8155.19' },
        { name: '2', value: '1113.27' },
      ]);
    });
  });

  describe('message + audit atomicity (spec "Message and audit atomic")', () => {
    it('a rollback mid-reply removes BOTH the outbound bot_message row and its audit', async () => {
      const t0 = nowSeconds();
      const { canonical } = await hybridPatientWithPinnedDebt();

      // Setup: identified + menu reply (1 outbound row + 1 sent audit).
      const setup = await deliverInbound([
        inboundMessage(canonical, 'wamid.bot.spec.atom.0', 'hola', t0),
      ]);
      expect(setup.status).toBe(200);
      const conversation = await findConversation(canonical);
      const outboundBefore = await outboundMessages(conversation.id);
      expect(outboundBefore).toHaveLength(1);
      const sentAuditsBefore = await auditsForRecordIds([outboundBefore[0].id]);
      expect(
        sentAuditsBefore.filter((a) => a.action === 'bot_message.sent'),
      ).toHaveLength(1);

      // Force the reply transaction to fail AFTER the outbound row insert:
      // the bot_message.sent audit throws inside the SAME transaction, so
      // both the row and the audit must roll back together.
      const originalLog = auditService.log;
      const auditSpy = jest.spyOn(auditService, 'log');
      auditSpy.mockImplementation(async (manager, entry) => {
        if (entry.action === 'bot_message.sent') {
          throw new Error('forced audit failure');
        }
        return originalLog.call(auditService, manager, entry);
      });
      let response: request.Response;
      try {
        response = await deliverInbound([
          inboundMessage(canonical, 'wamid.bot.spec.atom.1', 'saldo', t0 + 60),
        ]);
      } finally {
        auditSpy.mockRestore();
      }
      expect(response.status).toBe(500);

      // The inbound message + its received audit committed in the EARLIER
      // transaction; the outbound reply row and its sent audit are gone:
      // neither the bot_message row NOR the audit row exists for the reply.
      expect(await inboundCount(conversation.id)).toBe(2);
      const outboundAfter = await outboundMessages(conversation.id);
      expect(outboundAfter).toHaveLength(1);
      const sentAuditsAfter = await auditsForRecordIds([outboundAfter[0].id]);
      expect(
        sentAuditsAfter.filter((a) => a.action === 'bot_message.sent'),
      ).toHaveLength(1);
      // The provider was never called for the rolled-back reply.
      expect(provider.sent).toHaveLength(1);
    });
  });

  describe('actor vs system attribution (spec "Actor vs system attribution")', () => {
    it('manual dispatch audits carry the office user; bot audits carry NULL', async () => {
      const t0 = nowSeconds();
      const office = await officeUser();
      const { patientId, canonical } = await hybridPatientWithPinnedDebt();
      const template = await insertApprovedUtilityTemplate('Hola {{1}}');

      // Manual dispatch by the office user (dispatches.service.create with
      // the acting userId — the same contract the controller passes).
      const dispatch = await dispatchesService.create(
        {
          patientId,
          templateId: template.id,
          variables: { '1': 'Juan' },
        },
        office.id,
      );
      expect(dispatch.status).toBe('sent');

      const dispatchAudits = await auditsForRecordIds([dispatch.id]);
      expect(dispatchAudits.length).toBeGreaterThanOrEqual(2); // created + status_changed
      expect(
        dispatchAudits.some((a) => a.action === 'whatsapp_dispatch.created'),
      ).toBe(true);
      for (const audit of dispatchAudits) {
        expect(audit.userId).toBe(office.id);
      }

      // Bot flow from the same hybrid patient's number: every bot audit is a
      // system event (webhook has no authenticated user).
      const response = await deliverInbound([
        inboundMessage(canonical, 'wamid.bot.spec.attr.1', 'saldo', t0),
      ]);
      expect(response.status).toBe(200);

      const conversation = await findConversation(canonical);
      const messageRows: Array<{ id: string }> = await dataSource.query(
        `SELECT id FROM bot_messages WHERE conversation_id = $1`,
        [conversation.id],
      );
      const botAudits = await auditsForRecordIds([
        conversation.id,
        ...messageRows.map((row) => row.id),
      ]);
      expect(botAudits.length).toBeGreaterThan(0);
      expect(
        botAudits.some((a) => a.action === 'bot_conversation.started'),
      ).toBe(true);
      for (const audit of botAudits) {
        expect(audit.userId).toBeNull();
      }
    });
  });

  describe('audit PII boundary (AD9, spec "No PII in audit payloads")', () => {
    it('bot audits never carry wa_id, identity documents, message bodies, or debt amounts', async () => {
      const t0 = nowSeconds();
      const phone = uniquePhone();
      const { patientId, canonical } = await hybridPatientWithPinnedDebt();
      // A second candidate forces the awaiting_document path so the document
      // flow (wrong attempt + real document) is exercised.
      const secondDocument = uniqueIdentityDocument();
      await insertPatient(`+591${phone}`, secondDocument);

      await deliverInbound([
        inboundMessage(canonical, 'wamid.bot.spec.pii.1', 'hola', t0),
      ]);
      await deliverInbound([
        inboundMessage(
          canonical,
          'wamid.bot.spec.pii.2',
          'DOCUMENTO EQUIVOCADO',
          t0 + 1,
        ),
      ]);
      const patientRows: Array<{ identityDocument: string }> =
        await dataSource.query(
          `SELECT identity_document AS "identityDocument" FROM patients WHERE id = $1`,
          [patientId],
        );
      await deliverInbound([
        inboundMessage(
          canonical,
          'wamid.bot.spec.pii.3',
          patientRows[0].identityDocument,
          t0 + 2,
        ),
      ]);
      // Body sent as 'SALDO' (uppercase): the parser still resolves intent
      // 'saldo', but the as-sent body differs from the allowed `intent`
      // operational field — so a body leak would be detectable.
      await deliverInbound([
        inboundMessage(canonical, 'wamid.bot.spec.pii.4', 'SALDO', t0 + 3),
      ]);

      const conversation = await findConversation(canonical);
      expect(conversation.state).toBe('identified');
      const messageRows: Array<{ id: string }> = await dataSource.query(
        `SELECT id FROM bot_messages WHERE conversation_id = $1`,
        [conversation.id],
      );
      const audits = await auditsForRecordIds([
        conversation.id,
        ...messageRows.map((row) => row.id),
      ]);
      expect(audits.length).toBeGreaterThan(0);

      // AD9 allows ONLY operational fields (direction, type, intent,
      // patientId, state, failedAttempts) — assert the sent audit's shape
      // exactly (toEqual is key-order insensitive; PG jsonb reorders keys),
      // then prove nothing forbidden leaks into any payload.
      const sentAudits = audits.filter((a) => a.action === 'bot_message.sent');
      const saldoSentAudit = sentAudits.find(
        (a) => a.newData?.intent === 'saldo',
      );
      expect(saldoSentAudit?.newData).toEqual({
        direction: 'outbound',
        type: 'text',
        intent: 'saldo',
      });

      // The sensitive values flow through the whole exchange (wa_id, both
      // identity documents, the wrong-document body, inbound bodies, and the
      // debt amounts) and must appear NOWHERE in newData/previousData. The
      // bare lowercase 'saldo' IS allowed — it is the operational intent
      // field, which is why the body was sent as 'SALDO' above.
      const serialized = JSON.stringify(
        audits.map((audit) => ({
          action: audit.action,
          newData: audit.newData,
          previousData: audit.previousData,
        })),
      );
      const sensitiveValues = [
        canonical, // wa_id / phone
        patientRows[0].identityDocument, // the real document (identified)
        secondDocument, // the other candidate's document
        'DOCUMENTO EQUIVOCADO', // wrong document body
        'hola', // inbound body
        'SALDO', // inbound body as sent (intent 'saldo' lowercase is allowed)
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

  describe('duplicate webhook deliveries (proposal success criterion "duplicate webhook deliveries ignored")', () => {
    it('two deliveries of the same message id persist ONE bot_message row and ONE reply', async () => {
      const t0 = nowSeconds();
      const { canonical } = await hybridPatientWithPinnedDebt();
      const delivery = inboundMessage(
        canonical,
        'wamid.bot.spec.dup.1',
        'saldo',
        t0,
      );

      const first = await deliverInbound([delivery]);
      const second = await deliverInbound([delivery]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const rows: Array<{ count: string }> = await dataSource.query(
        `SELECT COUNT(*)::text AS count FROM bot_messages
          WHERE provider_message_id = 'wamid.bot.spec.dup.1'`,
      );
      expect(rows[0].count).toBe('1');

      const conversation = await findConversation(canonical);
      expect(conversation.state).toBe('identified');
      const messages: Array<{ direction: string }> = await dataSource.query(
        `SELECT direction FROM bot_messages WHERE conversation_id = $1`,
        [conversation.id],
      );
      expect(messages).toHaveLength(2);
      expect(
        messages.filter((row) => row.direction === 'inbound'),
      ).toHaveLength(1);
      expect(
        messages.filter((row) => row.direction === 'outbound'),
      ).toHaveLength(1);

      // One provider send, one started audit — the duplicate touched nothing.
      expect(provider.sent).toHaveLength(1);
      const audits = await auditsForRecordIds([conversation.id]);
      expect(
        audits.filter((a) => a.action === 'bot_conversation.started'),
      ).toHaveLength(1);
    });
  });
});
