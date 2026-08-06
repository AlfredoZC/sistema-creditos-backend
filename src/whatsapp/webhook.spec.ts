import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { DispatchStatus, TemplateStatus } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import {
  buildHandshakeGet,
  buildSignedWebhookPost,
  computeHubSignature,
  getTestWebhookAppSecret,
  getTestWebhookVerifyToken,
} from '../test-utils/whatsapp-webhook-client';
import { MockWhatsAppProvider } from './provider/mock-whatsapp-provider';
import { FREE_FORM_TEXT_SEND_TEMPLATE_NAME } from './bot.service';
import { normalizePhone } from './phone-normalizer';
import {
  isEffectiveDispatchTransition,
  mapProviderStatusToDispatchStatus,
} from './webhook.service';
import { mapProviderStatusToTemplateStatus } from './templates/templates.service';
import { WHATSAPP_PROVIDER } from './whatsapp.module';

jest.setTimeout(60000);

/**
 * Webhook integration spec (tasks 4.3–4.5, design §9.3): GET handshake +
 * signed POSTs built with test-utils/whatsapp-webhook-client (the client
 * signs the EXACT raw bytes the server verifies — AD3). Covers the spec
 * scenarios "Valid handshake echoes challenge", "Invalid token rejected",
 * "Tampered POST rejected unprocessed", "Duplicate delivery ignored" and
 * "Out-of-order status does not regress", plus the template-status mirror
 * (task 4.3 re-scope: minimal mirrorProviderStatus, NOT the full 2.4 scope).
 *
 * INBOUND WIRING (task 5.4): the `messages[]` path routes every entry into
 * BotService.processInbound (design §9.3 item 2 / §9.4) — the webhook stays
 * 200-fast and bot-level duplicate-delivery dedupe
 * (bot_messages.provider_message_id UNIQUE) is silent (AD6). The full bot
 * state-machine scenario coverage lives in bot.service.spec (tasks 5.3–5.4)
 * and the 5.5 bot spec.
 */

// Unique data per run: user/patient rows are shared with other integration
// suites on db_creditos_test (same convention as dispatches.spec.ts).
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

const WEBHOOK_PATH = '/api/whatsapp/webhook';
const AUDIT_DISPATCH_STATUS_CHANGED = 'whatsapp_dispatch.status_changed';
const AUDIT_TEMPLATE_STATUS_CHANGED = 'whatsapp_template.status_changed';

function uniqueIdentityDocument(): string {
  return `${RUN_SUFFIX}${uniqueCounter++}`.slice(-20);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// patients.phone is UNIQUE (migration 002) and patient rows are shared with
// other suites on db_creditos_test — every insert needs a fresh phone.
function uniquePhone(): string {
  const pid3 = String(process.pid).slice(0, 3).padStart(3, '0');
  const ts2 = String(Date.now()).slice(-2);
  const seq2 = String(uniqueCounter++).slice(-2).padStart(2, '0');
  return `7${pid3}${ts2}${seq2}`;
}

interface IdRow {
  id: string;
}

interface DispatchRow {
  id: string;
  status: string;
  providerMessageId: string | null;
}

interface AuditRow {
  action: string;
  userId: string | null;
  newData: Record<string, unknown> | null;
  previousData: Record<string, unknown> | null;
}

describe('Webhook pure transition helpers (design §9.3)', () => {
  it('accepts ONLY the effective edges sent→delivered, sent→failed, delivered→read', () => {
    expect(isEffectiveDispatchTransition(DispatchStatus.SENT, DispatchStatus.DELIVERED)).toBe(true);
    expect(isEffectiveDispatchTransition(DispatchStatus.SENT, DispatchStatus.FAILED)).toBe(true);
    expect(isEffectiveDispatchTransition(DispatchStatus.DELIVERED, DispatchStatus.READ)).toBe(true);
  });

  it('rejects duplicates, regressions, and out-of-machine edges', () => {
    // Duplicate delivery (spec "Duplicate delivery ignored").
    expect(isEffectiveDispatchTransition(DispatchStatus.DELIVERED, DispatchStatus.DELIVERED)).toBe(false);
    // Late 'sent' after 'delivered' must not regress (spec "Out-of-order
    // status does not regress").
    expect(isEffectiveDispatchTransition(DispatchStatus.DELIVERED, DispatchStatus.SENT)).toBe(false);
    // A read message can never go back to delivered.
    expect(isEffectiveDispatchTransition(DispatchStatus.READ, DispatchStatus.DELIVERED)).toBe(false);
    // failed→sent belongs to the manual retry flow, never the webhook.
    expect(isEffectiveDispatchTransition(DispatchStatus.FAILED, DispatchStatus.SENT)).toBe(false);
    // queued→sent is the service's own send path, never a webhook edge.
    expect(isEffectiveDispatchTransition(DispatchStatus.QUEUED, DispatchStatus.SENT)).toBe(false);
    // sent→read skips delivered — not an allowed edge.
    expect(isEffectiveDispatchTransition(DispatchStatus.SENT, DispatchStatus.READ)).toBe(false);
  });

  it('maps Meta provider status strings to dispatch statuses; unknown → null', () => {
    expect(mapProviderStatusToDispatchStatus('sent')).toBe(DispatchStatus.SENT);
    expect(mapProviderStatusToDispatchStatus('delivered')).toBe(DispatchStatus.DELIVERED);
    expect(mapProviderStatusToDispatchStatus('read')).toBe(DispatchStatus.READ);
    expect(mapProviderStatusToDispatchStatus('failed')).toBe(DispatchStatus.FAILED);
    expect(mapProviderStatusToDispatchStatus('deleted')).toBeNull();
    expect(mapProviderStatusToDispatchStatus('')).toBeNull();
  });

  it('maps Meta template events to template statuses; unknown → null', () => {
    expect(mapProviderStatusToTemplateStatus('IN_APPROVAL')).toBe(TemplateStatus.SUBMITTED);
    expect(mapProviderStatusToTemplateStatus('APPROVED')).toBe(TemplateStatus.APPROVED);
    expect(mapProviderStatusToTemplateStatus('REJECTED')).toBe(TemplateStatus.REJECTED);
    expect(mapProviderStatusToTemplateStatus('PAUSED')).toBe(TemplateStatus.PAUSED);
    // Case-insensitive: Meta may send either casing.
    expect(mapProviderStatusToTemplateStatus('approved')).toBe(TemplateStatus.APPROVED);
    // Events that do not map (IN_APPEAL, PENDING_DELETION, DISABLED, …) are
    // no-ops — never thrown.
    expect(mapProviderStatusToTemplateStatus('IN_APPEAL')).toBeNull();
    expect(mapProviderStatusToTemplateStatus('')).toBeNull();
  });
});

describe('Webhook GET handshake (spec "Webhook Contract: Handshake and Signature")', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('echoes the challenge as plain text with 200 (spec "Valid handshake echoes challenge")', async () => {
    const response = await buildHandshakeGet(
      app,
      WEBHOOK_PATH,
      getTestWebhookVerifyToken(),
      'abc123',
    );

    expect(response.status).toBe(200);
    expect(response.text).toBe('abc123');
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
  });

  it('rejects a non-matching verify_token with 403 (spec "Invalid token rejected")', async () => {
    const response = await buildHandshakeGet(
      app,
      WEBHOOK_PATH,
      'not-the-verify-token',
      'abc123',
    );

    expect(response.status).toBe(403);
  });

  it('rejects missing handshake params with 400', async () => {
    const missingAll = await request(app.getHttpServer()).get(WEBHOOK_PATH);
    const missingChallenge = await request(app.getHttpServer())
      .get(WEBHOOK_PATH)
      .query({
        'hub.mode': 'subscribe',
        'hub.verify_token': getTestWebhookVerifyToken(),
      });

    expect(missingAll.status).toBe(400);
    expect(missingChallenge.status).toBe(400);
  });

  it('rejects a mode other than subscribe with 403 even with a valid token', async () => {
    const response = await request(app.getHttpServer())
      .get(WEBHOOK_PATH)
      .query({
        'hub.mode': 'unsubscribe',
        'hub.verify_token': getTestWebhookVerifyToken(),
        'hub.challenge': 'abc123',
      });

    expect(response.status).toBe(403);
  });
});

describe('Webhook POST signature gate (AD3 — verify-then-parse)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let provider: MockWhatsAppProvider;
  let sentDispatchId: string;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    provider = app.get(WHATSAPP_PROVIDER) as MockWhatsAppProvider;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE whatsapp_dispatches, message_templates RESTART IDENTITY CASCADE',
    );
    provider.sent.length = 0;
    provider.submitted.length = 0;
    provider.failNext = false;
    sentDispatchId = await insertSentDispatch('wamid.webhook.tampered.1');
  });

  async function insertSentDispatch(wamid: string): Promise<string> {
    const phone = uniquePhone();
    const patientRows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Webhook', 'Patient', $2) RETURNING id`,
      [uniqueIdentityDocument(), phone],
    );
    const templateRows: IdRow[] = await dataSource.query(
      `INSERT INTO message_templates (name, category, language, body_template, status)
       VALUES ($1, 'utility', 'es', 'Hola {{1}}', 'approved') RETURNING id`,
      [`tpl_${RUN_SUFFIX}_${uniqueCounter++}`],
    );
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO whatsapp_dispatches
         (patient_id, template_id, status, send_attempts, provider_message_id, payload, phone)
       VALUES ($1, $2, 'sent', 1, $3, '{}', $4)
       RETURNING id`,
      [patientRows[0].id, templateRows[0].id, wamid, phone],
    );
    return rows[0].id;
  }

  async function storedDispatch(id: string): Promise<DispatchRow | undefined> {
    const rows: DispatchRow[] = await dataSource.query(
      `SELECT id,
              status,
              provider_message_id AS "providerMessageId"
         FROM whatsapp_dispatches
        WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function dispatchStatusChangedAudits(
    recordId: string,
  ): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT action,
              user_id AS "userId",
              new_data AS "newData",
              previous_data AS "previousData"
         FROM audit_logs
        WHERE record_id = $1 AND action = $2
        ORDER BY created_at`,
      [recordId, AUDIT_DISPATCH_STATUS_CHANGED],
    );
  }

  function deliveredPayloadFor(wamid: string): string {
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test-waba-id',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                statuses: [{ id: wamid, status: 'delivered', timestamp: '1700000000' }],
              },
            },
          ],
        },
      ],
    });
  }

  it('rejects a tampered POST (wrong signature) with 403 and processes nothing (spec "Tampered POST rejected unprocessed")', async () => {
    const rawBody = deliveredPayloadFor('wamid.webhook.tampered.1');
    const response = await request(app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      // Signed with the WRONG secret (shared client helper, negative case) —
      // must fail closed.
      .set('x-hub-signature-256', computeHubSignature('wrong-secret', rawBody))
      .send(rawBody);

    expect(response.status).toBe(403);
    // The response carries no business data.
    expect(response.body.status).toBeUndefined();

    // NOTHING was parsed or persisted: the dispatch is still 'sent' and no
    // status_changed audit exists for it.
    const row = await storedDispatch(sentDispatchId);
    expect(row?.status).toBe(DispatchStatus.SENT);
    expect(await dispatchStatusChangedAudits(sentDispatchId)).toHaveLength(0);
    expect(provider.sent).toHaveLength(0);
  });

  it('rejects a POST without signature header with 401 and processes nothing', async () => {
    const response = await request(app.getHttpServer())
      .post(WEBHOOK_PATH)
      .set('Content-Type', 'application/json')
      .send(deliveredPayloadFor('wamid.webhook.tampered.1'));

    expect(response.status).toBe(401);
    expect(response.body.status).toBeUndefined();

    const row = await storedDispatch(sentDispatchId);
    expect(row?.status).toBe(DispatchStatus.SENT);
    expect(await dispatchStatusChangedAudits(sentDispatchId)).toHaveLength(0);
    expect(provider.sent).toHaveLength(0);
  });
});

describe('Webhook POST statuses[] (spec "Webhook Status and Inbound Processing")', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    provider = app.get(WHATSAPP_PROVIDER) as MockWhatsAppProvider;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE whatsapp_dispatches, message_templates RESTART IDENTITY CASCADE',
    );
    provider.sent.length = 0;
    provider.submitted.length = 0;
    provider.failNext = false;
  });

  async function insertDispatch(
    wamid: string,
    status: DispatchStatus,
  ): Promise<string> {
    const phone = uniquePhone();
    const patientRows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Webhook', 'Patient', $2) RETURNING id`,
      [uniqueIdentityDocument(), phone],
    );
    const templateRows: IdRow[] = await dataSource.query(
      `INSERT INTO message_templates (name, category, language, body_template, status)
       VALUES ($1, 'utility', 'es', 'Hola {{1}}', 'approved') RETURNING id`,
      [`tpl_${RUN_SUFFIX}_${uniqueCounter++}`],
    );
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO whatsapp_dispatches
         (patient_id, template_id, status, send_attempts, provider_message_id, payload, phone)
       VALUES ($1, $2, $3, 1, $4, '{}', $5)
       RETURNING id`,
      [patientRows[0].id, templateRows[0].id, status, wamid, phone],
    );
    return rows[0].id;
  }

  function signedStatusPost(
    statuses: Array<{ id: string; status: string }>,
  ): request.Test {
    const rawBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test-waba-id',
          changes: [
            {
              field: 'messages',
              value: { messaging_product: 'whatsapp', statuses },
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

  async function storedDispatch(id: string): Promise<DispatchRow | undefined> {
    const rows: DispatchRow[] = await dataSource.query(
      `SELECT id,
              status,
              provider_message_id AS "providerMessageId"
         FROM whatsapp_dispatches
        WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function statusChangedAudits(recordId: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT action,
              user_id AS "userId",
              new_data AS "newData",
              previous_data AS "previousData"
         FROM audit_logs
        WHERE record_id = $1 AND action = $2
        ORDER BY created_at`,
      [recordId, AUDIT_DISPATCH_STATUS_CHANGED],
    );
  }

  it('applies an effective sent→delivered transition with one system audit', async () => {
    const dispatchId = await insertDispatch('wamid.webhook.1', DispatchStatus.SENT);

    const response = await signedStatusPost([
      { id: 'wamid.webhook.1', status: 'delivered' },
    ]);

    expect(response.status).toBe(200);
    const row = await storedDispatch(dispatchId);
    expect(row?.status).toBe(DispatchStatus.DELIVERED);
    expect(row?.providerMessageId).toBe('wamid.webhook.1');

    const audits = await statusChangedAudits(dispatchId);
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe(AUDIT_DISPATCH_STATUS_CHANGED);
    expect(audits[0].userId).toBeNull(); // system event, AD9
    expect(audits[0].previousData).toEqual({ status: DispatchStatus.SENT });
    expect(audits[0].newData).toEqual({
      status: DispatchStatus.DELIVERED,
      providerMessageId: 'wamid.webhook.1',
    });
    // Webhook processing never triggers provider sends.
    expect(provider.sent).toHaveLength(0);
  });

  it('ignores a duplicate delivery: 200, no state change, NO new audit (spec "Duplicate delivery ignored")', async () => {
    const dispatchId = await insertDispatch(
      'wamid.webhook.2',
      DispatchStatus.DELIVERED,
    );
    const auditsBefore = (await statusChangedAudits(dispatchId)).length;

    const response = await signedStatusPost([
      { id: 'wamid.webhook.2', status: 'delivered' },
    ]);

    expect(response.status).toBe(200);
    const row = await storedDispatch(dispatchId);
    expect(row?.status).toBe(DispatchStatus.DELIVERED);
    expect(await statusChangedAudits(dispatchId)).toHaveLength(auditsBefore);
  });

  it('does not regress on out-of-order statuses: late sent after delivered is a 200 no-op (spec "Out-of-order status does not regress")', async () => {
    const dispatchId = await insertDispatch(
      'wamid.webhook.3',
      DispatchStatus.DELIVERED,
    );
    const auditsBefore = (await statusChangedAudits(dispatchId)).length;

    const response = await signedStatusPost([
      { id: 'wamid.webhook.3', status: 'sent' },
    ]);

    expect(response.status).toBe(200);
    const row = await storedDispatch(dispatchId);
    expect(row?.status).toBe(DispatchStatus.DELIVERED);
    expect(await statusChangedAudits(dispatchId)).toHaveLength(auditsBefore);
  });

  it('applies an effective sent→failed transition (retryable terminal side)', async () => {
    const dispatchId = await insertDispatch('wamid.webhook.4', DispatchStatus.SENT);

    const response = await signedStatusPost([
      { id: 'wamid.webhook.4', status: 'failed' },
    ]);

    expect(response.status).toBe(200);
    const row = await storedDispatch(dispatchId);
    expect(row?.status).toBe(DispatchStatus.FAILED);
    const audits = await statusChangedAudits(dispatchId);
    expect(audits).toHaveLength(1);
    expect(audits[0].previousData).toEqual({ status: DispatchStatus.SENT });
    expect(audits[0].newData).toEqual({
      status: DispatchStatus.FAILED,
      providerMessageId: 'wamid.webhook.4',
    });
  });

  it('applies an effective delivered→read transition', async () => {
    const dispatchId = await insertDispatch(
      'wamid.webhook.5',
      DispatchStatus.DELIVERED,
    );

    const response = await signedStatusPost([
      { id: 'wamid.webhook.5', status: 'read' },
    ]);

    expect(response.status).toBe(200);
    const row = await storedDispatch(dispatchId);
    expect(row?.status).toBe(DispatchStatus.READ);
    expect(await statusChangedAudits(dispatchId)).toHaveLength(1);
  });

  it('answers 200 and persists nothing for an unknown wamid', async () => {
    const response = await signedStatusPost([
      { id: 'wamid.webhook.unknown', status: 'delivered' },
    ]);

    expect(response.status).toBe(200);
    const rows: { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
    );
    expect(rows[0].count).toBe('0');
  });

  it('accepts the flat payload shape (statuses at root, design §9.3)', async () => {
    const dispatchId = await insertDispatch('wamid.webhook.6', DispatchStatus.SENT);
    const rawBody = JSON.stringify({
      statuses: [{ id: 'wamid.webhook.6', status: 'delivered' }],
    });

    const response = await buildSignedWebhookPost(
      app,
      WEBHOOK_PATH,
      rawBody,
      getTestWebhookAppSecret(),
    );

    expect(response.status).toBe(200);
    const row = await storedDispatch(dispatchId);
    expect(row?.status).toBe(DispatchStatus.DELIVERED);
  });
});

describe('Webhook POST messages[] (inbound bot wiring — task 5.4)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
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
  });

  interface ConversationRow {
    id: string;
    waId: string;
    state: string;
  }

  interface MessageRow {
    id: string;
    body: string;
    direction: string;
    providerMessageId: string;
  }

  async function findConversation(waId: string): Promise<ConversationRow | undefined> {
    const rows: ConversationRow[] = await dataSource.query(
      `SELECT id, wa_id AS "waId", state
         FROM bot_conversations
        WHERE wa_id = $1`,
      [waId],
    );
    return rows[0];
  }

  async function messagesFor(conversationId: string): Promise<MessageRow[]> {
    return dataSource.query(
      `SELECT id, body, direction, provider_message_id AS "providerMessageId"
         FROM bot_messages
        WHERE conversation_id = $1
        ORDER BY created_at`,
      [conversationId],
    );
  }

  function signedInboundPost(messages: unknown[]): request.Test {
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

  it('routes an inbound message into the bot: conversation, message row, and reply, all with a 200 (design §9.3 item 2)', async () => {
    const phone = uniquePhone();
    await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Webhook', 'Bot', $2)`,
      [uniqueIdentityDocument(), phone],
    );
    const canonical = normalizePhone(phone);

    const response = await signedInboundPost([
      {
        from: canonical,
        id: 'wamid.inbound.1',
        timestamp: String(nowSeconds()),
        text: { body: 'saldo' },
      },
    ]);

    expect(response.status).toBe(200);

    // The bot identified the single phone match and replied with the menu.
    const conversation = await findConversation(canonical);
    expect(conversation?.state).toBe('identified');

    const messages = await messagesFor(conversation!.id);
    expect(messages).toHaveLength(2);
    expect(messages[0].direction).toBe('inbound');
    expect(messages[0].body).toBe('saldo');
    expect(messages[0].providerMessageId).toBe('wamid.inbound.1');
    expect(messages[1].direction).toBe('outbound');

    // The reply went through the provider (free-form marker, AD5-after-commit).
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].input.to).toBe(canonical);
    expect(provider.sent[0].input.templateName).toBe(
      FREE_FORM_TEXT_SEND_TEMPLATE_NAME,
    );
  });

  it('answers 200 for a duplicate delivery: bot dedupe keeps one inbound row and one reply (spec "Duplicate delivery ignored")', async () => {
    const phone = uniquePhone();
    await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Webhook', 'Bot', $2)`,
      [uniqueIdentityDocument(), phone],
    );
    const canonical = normalizePhone(phone);
    const inboundMessage = {
      from: canonical,
      id: 'wamid.inbound.2',
      timestamp: String(nowSeconds()),
      text: { body: 'hola' },
    };

    const first = await signedInboundPost([inboundMessage]);
    const second = await signedInboundPost([inboundMessage]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const conversation = await findConversation(canonical);
    expect(conversation?.state).toBe('identified');
    const messages = await messagesFor(conversation!.id);
    expect(messages.filter((row) => row.direction === 'inbound')).toHaveLength(1);
    expect(messages.filter((row) => row.direction === 'outbound')).toHaveLength(1);
    expect(provider.sent).toHaveLength(1);
  });

  it('skips malformed entries and answers 200 without touching the bot', async () => {
    const response = await signedInboundPost([
      { from: '+59170000001' }, // no id / text
      { id: 'wamid.inbound.3' }, // no from / text
      'not-an-object',
    ]);

    expect(response.status).toBe(200);
    const rows: { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS count FROM bot_conversations',
    );
    expect(rows[0].count).toBe('0');
    expect(provider.sent).toHaveLength(0);
  });
});

describe('Webhook POST message_template_status_update[] (mirrorProviderStatus, 4.3 re-scope)', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE whatsapp_dispatches, message_templates RESTART IDENTITY CASCADE',
    );
  });

  async function insertTemplate(
    status: TemplateStatus,
    providerTemplateId: string,
  ): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO message_templates
         (name, category, language, body_template, status, provider_template_id)
       VALUES ($1, 'utility', 'es', 'Hola {{1}}', $2, $3)
       RETURNING id`,
      [`tpl_${RUN_SUFFIX}_${uniqueCounter++}`, status, providerTemplateId],
    );
    return rows[0].id;
  }

  function signedTemplateUpdatePost(
    providerTemplateId: string,
    event: string,
  ): request.Test {
    const rawBody = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'test-waba-id',
          changes: [
            {
              field: 'message_template_status_update',
              value: {
                message_template_id: providerTemplateId,
                message_template_name: 'payment_reminder',
                event,
              },
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

  async function storedTemplate(id: string): Promise<{
    status: string;
    providerStatus: string | null;
  } | undefined> {
    const rows: Array<{ status: string; providerStatus: string | null }> =
      await dataSource.query(
        `SELECT status,
                provider_status AS "providerStatus"
           FROM message_templates
          WHERE id = $1`,
        [id],
      );
    return rows[0];
  }

  async function statusChangedAudits(recordId: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT action,
              user_id AS "userId",
              new_data AS "newData",
              previous_data AS "previousData"
         FROM audit_logs
        WHERE record_id = $1 AND action = $2
        ORDER BY created_at`,
      [recordId, AUDIT_TEMPLATE_STATUS_CHANGED],
    );
  }

  it('mirrors APPROVED onto a submitted template: status + provider_status + one system audit', async () => {
    const templateId = await insertTemplate(
      TemplateStatus.SUBMITTED,
      'template.meta.1',
    );

    const response = await signedTemplateUpdatePost(
      'template.meta.1',
      'APPROVED',
    );

    expect(response.status).toBe(200);
    const row = await storedTemplate(templateId);
    expect(row?.status).toBe(TemplateStatus.APPROVED);
    expect(row?.providerStatus).toBe('APPROVED');

    const audits = await statusChangedAudits(templateId);
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBeNull(); // system event, AD9
    expect(audits[0].previousData).toEqual({ status: TemplateStatus.SUBMITTED });
    expect(audits[0].newData).toEqual({
      status: TemplateStatus.APPROVED,
      providerStatus: 'APPROVED',
    });
  });

  it('is idempotent: a duplicate APPROVED event changes nothing and audits nothing', async () => {
    const templateId = await insertTemplate(
      TemplateStatus.APPROVED,
      'template.meta.2',
    );
    const auditsBefore = (await statusChangedAudits(templateId)).length;

    const response = await signedTemplateUpdatePost(
      'template.meta.2',
      'APPROVED',
    );

    expect(response.status).toBe(200);
    const row = await storedTemplate(templateId);
    expect(row?.status).toBe(TemplateStatus.APPROVED);
    expect(await statusChangedAudits(templateId)).toHaveLength(auditsBefore);
  });

  it('answers 200 and never throws for an unknown provider event (IN_APPEAL)', async () => {
    const templateId = await insertTemplate(
      TemplateStatus.SUBMITTED,
      'template.meta.3',
    );

    const response = await signedTemplateUpdatePost(
      'template.meta.3',
      'IN_APPEAL',
    );

    expect(response.status).toBe(200);
    const row = await storedTemplate(templateId);
    expect(row?.status).toBe(TemplateStatus.SUBMITTED);
    expect(await statusChangedAudits(templateId)).toHaveLength(0);
  });

  it('answers 200 and changes nothing for an unknown provider template id', async () => {
    const response = await signedTemplateUpdatePost(
      'template.meta.does-not-exist',
      'APPROVED',
    );

    expect(response.status).toBe(200);
    const rows: { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS count FROM message_templates',
    );
    expect(rows[0].count).toBe('0');
  });

  it('never regresses: APPROVED on a draft template is a 200 no-op (transition guard)', async () => {
    const templateId = await insertTemplate(
      TemplateStatus.DRAFT,
      'template.meta.4',
    );

    const response = await signedTemplateUpdatePost(
      'template.meta.4',
      'APPROVED',
    );

    expect(response.status).toBe(200);
    const row = await storedTemplate(templateId);
    expect(row?.status).toBe(TemplateStatus.DRAFT);
    expect(await statusChangedAudits(templateId)).toHaveLength(0);
  });
});
