import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { DispatchStatus, TemplateStatus, UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { DispatchesService } from './dispatches.service';
import { MetaCloudApiProvider } from './provider/meta-cloud-api.provider';
import { MockWhatsAppProvider } from './provider/mock-whatsapp-provider';
import { WHATSAPP_PROVIDER } from './whatsapp.module';

// Mock isolation (spec "Mock provider isolation", design §7): with
// WHATSAPP_PROVIDER=mock the Meta adapter must NEVER be constructed. The mock
// class records constructions so the suite can assert zero across every
// dispatch flow — the same technique as whatsapp-provider.factory.spec.ts.
jest.mock('./provider/meta-cloud-api.provider', () => {
  const actual = jest.requireActual('./provider/meta-cloud-api.provider');
  const MockedMetaCloudApiProvider = jest.fn(function (config: unknown) {
    return Reflect.construct(actual.MetaCloudApiProvider, [config]);
  });
  return { ...actual, MetaCloudApiProvider: MockedMetaCloudApiProvider };
});

const MockedMetaCloudApiProvider = MetaCloudApiProvider as unknown as jest.Mock;

jest.setTimeout(60000);

// Unique data per run: the suite truncates whatsapp_dispatches, but user and
// patient rows are shared with other integration suites on db_creditos_test,
// so emails/phones/identity documents carry a per-run suffix — the shared
// convention (same pattern as dispatches.service.spec.ts).
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

function uniquePhone(): string {
  const pid3 = String(process.pid).slice(0, 3).padStart(3, '0');
  const ts2 = String(Date.now()).slice(-2);
  const seq2 = String(uniqueCounter++).slice(-2).padStart(2, '0');
  return `7${pid3}${ts2}${seq2}`;
}

function uniqueIdentityDocument(): string {
  return `${RUN_SUFFIX}${uniqueCounter++}`.slice(-20);
}

function emailFor(localPart: string): string {
  return `${localPart}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`;
}

interface IdRow {
  id: string;
}

interface DispatchRow {
  id: string;
  status: string;
  sendAttempts: number;
  providerMessageId: string | null;
  providerError: string | null;
  payload: Record<string, string>;
  phone: string;
  sentAt: string | null;
  createdByUserId: string | null;
}

interface AuditRow {
  action: string;
  userId: string | null;
  newData: Record<string, unknown> | null;
  previousData: Record<string, unknown> | null;
}

const TEMPLATE_BODY = 'Hola {{1}}, tu pago de {{2}} vence el {{3}}.';

/**
 * DispatchesController endpoint contract (tasks 3.3–3.4, design §9.2): POST
 * create (201, row queued→sent + audits, provider called AFTER commit),
 * POST :id/retry (queued|failed only; terminal/attempt-limit 409), GET list
 * (PaginationDto + status filter) and GET :id — all under @Auth(OFFICE,
 * ADMIN). Includes the concurrent dedupe and mock-isolation evidence required
 * by spec "Outbound Dispatch Trigger" scenarios.
 */
describe('DispatchesController (HTTP contract, design §9.2)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let service: DispatchesService;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
    service = app.get(DispatchesService);
    provider = app.get(WHATSAPP_PROVIDER) as MockWhatsAppProvider;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE whatsapp_dispatches RESTART IDENTITY CASCADE',
    );
    provider.sent.length = 0;
    provider.submitted.length = 0;
    provider.failNext = false;
    MockedMetaCloudApiProvider.mockClear();
  });

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

  async function roleToken(role: UserRole, label: string): Promise<string> {
    const id = await insertUserRaw(
      emailFor(`${label}.dispatches.${uniqueCounter++}`),
      `Dispatches ${label}`,
      role,
    );
    return jwtService.sign({ id });
  }

  async function insertPatient(phone?: string): Promise<{
    id: string;
    phone: string;
  }> {
    const value = phone ?? uniquePhone();
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [uniqueIdentityDocument(), 'Dispatch', 'Patient', value],
    );
    return { id: rows[0].id, phone: value };
  }

  async function insertTemplate(
    body: string,
    overrides: { status?: string; isActive?: boolean } = {},
  ): Promise<{ id: string; name: string; language: string }> {
    const name = `tpl_${RUN_SUFFIX}_${uniqueCounter++}`;
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO message_templates (name, category, language, body_template, status, is_active)
       VALUES ($1, 'utility', 'es', $2, $3, $4) RETURNING id`,
      [
        name,
        body,
        overrides.status ?? TemplateStatus.APPROVED,
        overrides.isActive ?? true,
      ],
    );
    return { id: rows[0].id, name, language: 'es' };
  }

  function createDispatch(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/whatsapp/dispatches')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function retryDispatch(token: string, id: string) {
    return request(app.getHttpServer())
      .post(`/api/whatsapp/dispatches/${id}/retry`)
      .set('Authorization', `Bearer ${token}`);
  }

  function listDispatches(token: string, query: string = '') {
    return request(app.getHttpServer())
      .get(`/api/whatsapp/dispatches${query}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function getDispatch(token: string, id: string) {
    return request(app.getHttpServer())
      .get(`/api/whatsapp/dispatches/${id}`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function storedDispatch(id: string): Promise<DispatchRow | undefined> {
    const rows: DispatchRow[] = await dataSource.query(
      `SELECT id,
              status,
              send_attempts AS "sendAttempts",
              provider_message_id AS "providerMessageId",
              provider_error AS "providerError",
              payload,
              phone,
              sent_at AS "sentAt",
              created_by_user_id AS "createdByUserId"
         FROM whatsapp_dispatches
        WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function auditsFor(recordId: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT action,
              user_id AS "userId",
              new_data AS "newData",
              previous_data AS "previousData"
         FROM audit_logs
        WHERE record_id = $1
        ORDER BY created_at`,
      [recordId],
    );
  }

  describe('POST /api/whatsapp/dispatches', () => {
    it('happy path: 201, row commits queued + audit, provider called after commit, then sent with wamid (spec "Happy path dispatch")', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const officeId = (jwtService.decode(officeToken) as { id: string }).id;
      const patient = await insertPatient();
      const template = await insertTemplate(TEMPLATE_BODY);

      const response = await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan', '2': 'Bs 8155.19', '3': '2026-08-05' },
      });

      expect(response.status).toBe(201);
      expect(response.body.patientId).toBe(patient.id);
      expect(response.body.templateId).toBe(template.id);
      expect(response.body.status).toBe(DispatchStatus.SENT);
      expect(response.body.sendAttempts).toBe(1);
      expect(response.body.providerMessageId).toMatch(/^wamid\.mock\.\d+$/);
      expect(response.body.sentAt).not.toBeNull();

      // Provider was called AFTER the business transaction committed and
      // recorded exactly one send with the canonical phone snapshot.
      expect(provider.name).toBe('mock');
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].input).toEqual({
        to: `+591${patient.phone}`,
        templateName: template.name,
        language: template.language,
        variables: [
          { name: '1', value: 'Juan' },
          { name: '2', value: 'Bs 8155.19' },
          { name: '3', value: '2026-08-05' },
        ],
      });

      // The audit trail proves the row first committed 'queued' (created
      // audit) and only then transitioned to 'sent' (status_changed).
      const row = await storedDispatch(response.body.id as string);
      expect(row?.status).toBe(DispatchStatus.SENT);
      expect(row?.payload).toEqual({
        '1': 'Juan',
        '2': 'Bs 8155.19',
        '3': '2026-08-05',
      });

      const audits = await auditsFor(response.body.id as string);
      expect(audits.map((a) => a.action)).toEqual([
        'whatsapp_dispatch.created',
        'whatsapp_dispatch.status_changed',
      ]);
      expect(audits[0].newData).toEqual({
        patientId: patient.id,
        templateId: template.id,
        status: DispatchStatus.QUEUED,
        sendAttempts: 1,
      });
      expect(audits[1].previousData).toEqual({ status: DispatchStatus.QUEUED });
      expect(audits[1].newData).toEqual({
        status: DispatchStatus.SENT,
        providerMessageId: row?.providerMessageId,
      });
      // Actor attribution: the manual dispatch audit's user_id is the office
      // user (spec "Actor vs system attribution").
      expect(audits.every((a) => a.userId === officeId)).toBe(true);
    });

    it('rejects malformed payloads with 400 and no row (whitelist + IsUUID + IsObject)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate(TEMPLATE_BODY);

      const cases: Record<string, unknown>[] = [
        { templateId: template.id, variables: { '1': 'x' } }, // missing patientId
        { patientId: 'not-a-uuid', templateId: template.id, variables: {} },
        { patientId: patient.id, templateId: template.id }, // missing variables
        { patientId: patient.id, templateId: template.id, variables: [] }, // not an object
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'x' },
          extra: 'forbidden',
        }, // forbidNonWhitelisted
      ];

      for (const payload of cases) {
        const response = await createDispatch(officeToken, payload);
        expect(response.status).toBe(400);
      }

      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
      );
      expect(rows[0].count).toBe('0');
      expect(provider.sent).toHaveLength(0);
    });

    it('rejects variables that do not map 1:1 to placeholders with 400 (spec "Placeholder mismatch rejected")', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate(TEMPLATE_BODY);

      const response = await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan' },
      });

      expect(response.status).toBe(400);
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
      );
      expect(rows[0].count).toBe('0');
      expect(provider.sent).toHaveLength(0);
    });

    it('rejects a non-dispatchable template with 409 and no row or provider call (spec "Rejected, paused, or deactivated blocked")', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const draftTemplate = await insertTemplate('Hola {{1}}', {
        status: TemplateStatus.DRAFT,
      });

      const response = await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: draftTemplate.id,
        variables: { '1': 'x' },
      });

      expect(response.status).toBe(409);
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
      );
      expect(rows[0].count).toBe('0');
      expect(provider.sent).toHaveLength(0);
    });

    it('returns 404 for an unknown patient id', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const template = await insertTemplate('Hola {{1}}');

      const response = await createDispatch(officeToken, {
        patientId: '00000000-0000-4000-8000-000000000000',
        templateId: template.id,
        variables: { '1': 'x' },
      });

      expect(response.status).toBe(404);
      expect(provider.sent).toHaveLength(0);
    });

    it('deduplicates identical requests: second POST gets 409, one row, one provider call (spec "Duplicate dispatch deduplicated")', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');
      const payload = {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan' },
      };

      const first = await createDispatch(officeToken, payload);
      expect(first.status).toBe(201);

      const duplicate = await createDispatch(officeToken, payload);

      expect(duplicate.status).toBe(409);
      expect(duplicate.body.message).toBe(
        'An identical dispatch already exists',
      );
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
      );
      expect(rows[0].count).toBe('1');
      expect(provider.sent).toHaveLength(1);
    });

    it('deduplicates two concurrent identical POSTs into one row and one provider call; loser gets 409', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');
      const payload = {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan' },
      };

      const [first, second] = await Promise.all([
        createDispatch(officeToken, payload),
        createDispatch(officeToken, payload),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
      );
      expect(rows[0].count).toBe('1');
      expect(provider.sent).toHaveLength(1);
    });

    it('never makes a real network call: fetch never invoked, Meta adapter never constructed (spec "Mock provider isolation")', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');

      const response = await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'x' },
      });

      expect(response.status).toBe(201);
      expect(provider.name).toBe('mock');
      expect(provider.sent).toHaveLength(1);
      expect(MockedMetaCloudApiProvider).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe('POST /api/whatsapp/dispatches/:id/retry', () => {
    it('retries a failed dispatch through queued to sent with a new wamid and audits (spec "Failed dispatch retried")', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const officeId = (jwtService.decode(officeToken) as { id: string }).id;
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');

      provider.failNext = true;
      const failed = await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan' },
      });
      expect(failed.status).toBe(201);
      expect(failed.body.status).toBe(DispatchStatus.FAILED);
      expect(failed.body.providerMessageId).toBeNull();

      const retried = await retryDispatch(
        officeToken,
        failed.body.id as string,
      );

      // POST action endpoint: 200 with the updated resource (payments
      // :id/confirm/:id/reject convention), new wamid, attempt incremented.
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe(DispatchStatus.SENT);
      expect(retried.body.sendAttempts).toBe(2);
      expect(retried.body.providerMessageId).toMatch(/^wamid\.mock\.\d+$/);
      expect(retried.body.providerError).toBeNull();

      const row = await storedDispatch(failed.body.id as string);
      expect(row?.status).toBe(DispatchStatus.SENT);
      expect(row?.sendAttempts).toBe(2);
      expect(row?.providerMessageId).toMatch(/^wamid\.mock\.\d+$/);
      expect(provider.sent).toHaveLength(1);

      const audits = await auditsFor(failed.body.id as string);
      const statusAudits = audits.filter(
        (a) => a.action === 'whatsapp_dispatch.status_changed',
      );
      expect(statusAudits.map((a) => a.previousData?.status)).toEqual([
        DispatchStatus.QUEUED,
        DispatchStatus.FAILED,
        DispatchStatus.QUEUED,
      ]);
      expect(statusAudits.map((a) => a.newData?.status)).toEqual([
        DispatchStatus.FAILED,
        DispatchStatus.QUEUED,
        DispatchStatus.SENT,
      ]);
      expect(statusAudits[1].newData?.sendAttempts).toBe(2);
      expect(audits.every((a) => a.userId === officeId)).toBe(true);
    });

    it('rejects retry of a terminal delivered dispatch with 409 and no provider call (spec "Terminal status cannot be retried")', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');

      const created = await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'x' },
      });
      expect(created.status).toBe(201);

      await dataSource.query(
        `UPDATE whatsapp_dispatches
            SET status = $1, provider_message_id = $2
          WHERE id = $3`,
        [DispatchStatus.DELIVERED, 'wamid.delivered.1', created.body.id],
      );

      const sentBeforeRetry = provider.sent.length;
      const response = await retryDispatch(
        officeToken,
        created.body.id as string,
      );

      expect(response.status).toBe(409);
      expect(provider.sent).toHaveLength(sentBeforeRetry);
      const row = await storedDispatch(created.body.id as string);
      expect(row?.status).toBe(DispatchStatus.DELIVERED);
      expect(row?.sendAttempts).toBe(1);
    });

    it('rejects retry at the attempt limit with 409 after 3 send attempts (spec "Attempt limit reached")', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');
      const payload = {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan' },
      };

      // Attempt 1: the initial create fails.
      provider.failNext = true;
      const created = await createDispatch(officeToken, payload);
      expect(created.status).toBe(201);
      expect(created.body.status).toBe(DispatchStatus.FAILED);

      // Attempts 2 and 3: retries fail again.
      provider.failNext = true;
      const second = await retryDispatch(
        officeToken,
        created.body.id as string,
      );
      expect(second.status).toBe(200);
      expect(second.body.status).toBe(DispatchStatus.FAILED);

      provider.failNext = true;
      const third = await retryDispatch(officeToken, created.body.id as string);
      expect(third.status).toBe(200);
      expect(third.body.status).toBe(DispatchStatus.FAILED);

      let row = await storedDispatch(created.body.id as string);
      expect(row?.sendAttempts).toBe(3);
      expect(row?.status).toBe(DispatchStatus.FAILED);

      // Fourth attempt must be rejected by the service gate with 409 — the
      // send_attempts CHECK (<= 3) is never exercised.
      const sentBeforeRetry = provider.sent.length;
      const fourth = await retryDispatch(
        officeToken,
        created.body.id as string,
      );
      expect(fourth.status).toBe(409);
      expect(provider.sent).toHaveLength(sentBeforeRetry);

      row = await storedDispatch(created.body.id as string);
      expect(row?.sendAttempts).toBe(3);
      expect(row?.status).toBe(DispatchStatus.FAILED);
    });

    it('returns 404 when retrying an unknown dispatch id', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');

      const response = await retryDispatch(
        officeToken,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(response.status).toBe(404);
      expect(provider.sent).toHaveLength(0);
    });
  });

  describe('GET /api/whatsapp/dispatches', () => {
    it('lists dispatches paginated for an office user (PaginationDto envelope)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');

      // Different variables => different dedupe keys => two independent rows.
      await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'a' },
      });
      await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'b' },
      });

      const response = await listDispatches(officeToken);

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.total).toBe(2);
      expect(response.body.limit).toBe(10);
      expect(response.body.offset).toBe(0);
      expect((response.body.data as { id: string }[]).map((d) => d.id)).toEqual(
        expect.arrayContaining([expect.any(String), expect.any(String)]),
      );
    });

    it('applies limit and offset (2 of 3 dispatches)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');

      for (const variable of ['a', 'b', 'c']) {
        await createDispatch(officeToken, {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': variable },
        });
      }

      const response = await listDispatches(officeToken, '?limit=2&offset=1');

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(2);
      expect(response.body.total).toBe(3);
      expect(response.body.limit).toBe(2);
      expect(response.body.offset).toBe(1);
    });

    it('filters by status (only matching dispatches)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');

      await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'sent' },
      });
      provider.failNext = true;
      await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'failed' },
      });

      const failedList = await listDispatches(
        officeToken,
        `?status=${DispatchStatus.FAILED}`,
      );
      const sentList = await listDispatches(
        officeToken,
        `?status=${DispatchStatus.SENT}`,
      );

      expect(failedList.status).toBe(200);
      expect(failedList.body.total).toBe(1);
      expect(failedList.body.data).toHaveLength(1);
      expect(failedList.body.data[0].status).toBe(DispatchStatus.FAILED);
      expect(sentList.status).toBe(200);
      expect(sentList.body.total).toBe(1);
      expect(sentList.body.data[0].status).toBe(DispatchStatus.SENT);
    });

    it('rejects an invalid status filter value with 400', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');

      const response = await listDispatches(officeToken, '?status=deleted');

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/whatsapp/dispatches/:id', () => {
    it('returns the dispatch detail (200)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');

      const created = await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan' },
      });

      const response = await getDispatch(
        officeToken,
        created.body.id as string,
      );

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.id);
      expect(response.body.patientId).toBe(patient.id);
      expect(response.body.templateId).toBe(template.id);
      expect(response.body.status).toBe(DispatchStatus.SENT);
    });

    it('returns 404 for an unknown dispatch id', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');

      const response = await getDispatch(
        officeToken,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(response.status).toBe(404);
    });
  });

  describe('actor vs system attribution (spec "Actor vs system attribution")', () => {
    it('audits a system-triggered dispatch (service userId null) with user_id NULL', async () => {
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');

      const dispatch = await service.create(
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'Juan' },
        },
        null,
      );

      const audits = await auditsFor(dispatch.id);
      expect(audits.map((a) => a.action)).toEqual([
        'whatsapp_dispatch.created',
        'whatsapp_dispatch.status_changed',
      ]);
      // The manual-office case (user_id = office) is asserted in the create
      // happy path; the system path must record NULL on every audit row.
      expect(audits.every((a) => a.userId === null)).toBe(true);
    });
  });

  describe('role guard (@Auth(OFFICE, ADMIN))', () => {
    it('lets an admin user create, list, and retry (2xx)', async () => {
      const adminToken = await roleToken(UserRole.ADMIN, 'admin');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');

      const created = await createDispatch(adminToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'x' },
      });
      const list = await listDispatches(adminToken);
      const retry = await retryDispatch(
        adminToken,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(created.status).toBe(201);
      expect(list.status).toBe(200);
      // The retry 404 proves the admin passed the role guard and reached the
      // handler (an unguarded 403 would never surface the NotFound).
      expect(retry.status).toBe(404);
    });

    it('rejects a patient on every endpoint with 403', async () => {
      const patientToken = await roleToken(UserRole.PATIENT, 'patient');

      const create = await createDispatch(patientToken, {
        patientId: '00000000-0000-4000-8000-000000000000',
        templateId: '00000000-0000-4000-8000-000000000000',
        variables: { '1': 'x' },
      });
      const retry = await retryDispatch(
        patientToken,
        '00000000-0000-4000-8000-000000000000',
      );
      const list = await listDispatches(patientToken);
      const get = await getDispatch(
        patientToken,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(create.status).toBe(403);
      expect(retry.status).toBe(403);
      expect(list.status).toBe(403);
      expect(get.status).toBe(403);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/whatsapp/dispatches',
      );

      expect(response.status).toBe(401);
    });
  });
});
