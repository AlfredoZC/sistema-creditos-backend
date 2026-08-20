import {
  BadRequestException,
  ConflictException,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { DispatchStatus, TemplateStatus } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { MockWhatsAppProvider } from './provider/mock-whatsapp-provider';
import { WhatsAppDispatch } from './entities';
import {
  DispatchesService,
  extractPlaceholderNumbers,
} from './dispatches.service';
import { WHATSAPP_PROVIDER } from './whatsapp.module';
import { uniqueMobile8 } from '../test-utils/unique-phone';

jest.setTimeout(60000);

const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

// 8-digit national mobile starting with 7 — exercises the +591 heuristic. La
// unicidad la garantiza el helper compartido: el contador por archivo
// colisionaba con el de otras suites al correr todo en un mismo proceso.
function uniquePhone(): string {
  return uniqueMobile8();
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

describe('WhatsAppDispatch entity (maps migration 003 whatsapp_dispatches, task 3.1)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let dispatchRepository: Repository<WhatsAppDispatch>;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    dispatchRepository = app.get(getRepositoryToken(WhatsAppDispatch));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE whatsapp_dispatches RESTART IDENTITY CASCADE',
    );
  });

  it('round-trips every column exactly as the migration DDL declares it', async () => {
    // Fixture dependencies: a real patient (FK) and a real template (FK).
    const userRows: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [emailFor('entity.actor'), 'hashed-password', 'Entity Actor', 'office'],
    );
    const patientRows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [uniqueIdentityDocument(), 'Entity', 'Patient', uniquePhone()],
    );
    const templateRows: IdRow[] = await dataSource.query(
      `INSERT INTO message_templates (name, category, language, body_template)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [`entity_map_${RUN_SUFFIX}`, 'utility', 'es', 'Hola {{1}}'],
    );

    const created = await dispatchRepository.save(
      dispatchRepository.create({
        patientId: patientRows[0].id,
        templateId: templateRows[0].id,
        status: DispatchStatus.QUEUED,
        sendAttempts: 1,
        providerMessageId: null,
        providerError: null,
        payload: { '1': 'Juan' },
        phone: '+59170000001',
        dedupeKey: 'a'.repeat(64),
        createdByUserId: userRows[0].id,
      }),
    );

    // Raw SQL select — asserts the TypeORM mapping (snake_case names, enum
    // storage, smallint, jsonb, nullable columns) against the real DDL.
    const rows: {
      patientId: string;
      templateId: string;
      status: string;
      sendAttempts: number;
      providerMessageId: string | null;
      providerError: string | null;
      payload: Record<string, string>;
      phone: string;
      dedupeKey: string | null;
      createdByUserId: string | null;
      sentAt: string | null;
    }[] = await dataSource.query(
      `SELECT patient_id AS "patientId",
              template_id AS "templateId",
              status,
              send_attempts AS "sendAttempts",
              provider_message_id AS "providerMessageId",
              provider_error AS "providerError",
              payload,
              phone,
              dedupe_key AS "dedupeKey",
              created_by_user_id AS "createdByUserId",
              sent_at AS "sentAt"
         FROM whatsapp_dispatches
        WHERE id = $1`,
      [created.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      patientId: patientRows[0].id,
      templateId: templateRows[0].id,
      status: DispatchStatus.QUEUED,
      sendAttempts: 1,
      providerMessageId: null,
      providerError: null,
      payload: { '1': 'Juan' },
      phone: '+59170000001',
      dedupeKey: 'a'.repeat(64),
      createdByUserId: userRows[0].id,
      sentAt: null,
    });
  });
});

interface AuditRow {
  action: string;
  userId: string | null;
  newData: Record<string, unknown> | null;
  previousData: Record<string, unknown> | null;
}

interface DispatchRow {
  id: string;
  status: string;
  sendAttempts: number;
  providerMessageId: string | null;
  providerError: string | null;
  payload: Record<string, string>;
  phone: string;
  dedupeKey: string | null;
  sentAt: string | null;
  createdByUserId: string | null;
}

describe('DispatchesService (design §9.2 — create + retry + dedupe, task 3.2)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: DispatchesService;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
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
  });

  async function insertActor(): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [
        emailFor('dispatch.actor'),
        'hashed-password',
        'Dispatch Actor',
        'office',
      ],
    );
    return rows[0].id;
  }

  async function insertPatient(phone?: string): Promise<{
    id: string;
    phone: string;
  }> {
    const value = phone ?? uniquePhone();
    const rows: { id: string }[] = await dataSource.query(
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
    const rows: { id: string }[] = await dataSource.query(
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

  async function storedDispatch(id: string): Promise<DispatchRow | undefined> {
    const rows: DispatchRow[] = await dataSource.query(
      `SELECT id,
              status,
              send_attempts AS "sendAttempts",
              provider_message_id AS "providerMessageId",
              provider_error AS "providerError",
              payload,
              phone,
              dedupe_key AS "dedupeKey",
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

  describe('create', () => {
    it('happy path: commits queued + audit, then sends and becomes sent with wamid (spec "Happy path dispatch")', async () => {
      const actorId = await insertActor();
      const patient = await insertPatient();
      const template = await insertTemplate(
        'Hola {{1}}, tu pago de {{2}} vence el {{3}}.',
      );

      const dispatch = await service.create(
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'Juan', '2': 'Bs 8155.19', '3': '2026-08-05' },
        },
        actorId,
      );

      // Mock isolation: the provider is the mock, it recorded exactly one call.
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

      const row = await storedDispatch(dispatch.id);
      expect(row?.status).toBe(DispatchStatus.SENT);
      expect(row?.sendAttempts).toBe(1);
      expect(row?.providerMessageId).toMatch(/^wamid\.mock\.\d+$/);
      expect(row?.sentAt).not.toBeNull();

      const audits = await auditsFor(dispatch.id);
      expect(audits.map((a) => a.action)).toEqual([
        'whatsapp_dispatch.created',
        'whatsapp_dispatch.status_changed',
      ]);
      expect(audits[0].userId).toBe(actorId);
      expect(audits[0].newData).toEqual({
        patientId: patient.id,
        templateId: template.id,
        status: DispatchStatus.QUEUED,
        sendAttempts: 1,
      });
      expect(audits[1].newData).toEqual({
        status: DispatchStatus.SENT,
        providerMessageId: row?.providerMessageId,
      });
      expect(audits[1].previousData).toEqual({ status: DispatchStatus.QUEUED });
    });

    it('persists the row as failed when the provider rejects (provider is called AFTER the insert commit — AD5)', async () => {
      const actorId = await insertActor();
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');
      provider.failNext = true;

      const dispatch = await service.create(
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'Juan' },
        },
        actorId,
      );

      // If the provider were called inside the insert transaction, a provider
      // failure would roll the row back — its persistence as `failed` proves
      // the insert committed first (design AD5 sequence).
      const row = await storedDispatch(dispatch.id);
      expect(row?.status).toBe(DispatchStatus.FAILED);
      expect(row?.sendAttempts).toBe(1);
      expect(row?.providerMessageId).toBeNull();
      expect(row?.providerError).toContain('Mock provider forced failure');
      expect(provider.sent).toHaveLength(0);

      const audits = await auditsFor(dispatch.id);
      expect(audits.map((a) => a.action)).toEqual([
        'whatsapp_dispatch.created',
        'whatsapp_dispatch.status_changed',
      ]);
      expect(audits[1].previousData).toEqual({ status: DispatchStatus.QUEUED });
      expect(audits[1].newData).toEqual({ status: DispatchStatus.FAILED });
      // AD9: the provider error is never mirrored to the audit.
      expect(audits[1].newData?.providerError).toBeUndefined();
    });

    it('rejects a non-dispatchable template with 409 and no row or provider call (spec "Rejected, paused, or deactivated blocked")', async () => {
      const patient = await insertPatient();
      const draftTemplate = await insertTemplate('Hola {{1}}', {
        status: TemplateStatus.DRAFT,
      });

      await expect(
        service.create(
          {
            patientId: patient.id,
            templateId: draftTemplate.id,
            variables: { '1': 'x' },
          },
          null,
        ),
      ).rejects.toThrow(ConflictException);
      expect(provider.sent).toHaveLength(0);
      expect(await storedDispatch(draftTemplate.id)).toBeUndefined();
    });

    it('rejects a deactivated approved template with 409 (deactivation blocks dispatch)', async () => {
      const patient = await insertPatient();
      const deactivated = await insertTemplate('Hola {{1}}', {
        isActive: false,
      });

      await expect(
        service.create(
          {
            patientId: patient.id,
            templateId: deactivated.id,
            variables: { '1': 'x' },
          },
          null,
        ),
      ).rejects.toThrow(ConflictException);
      expect(provider.sent).toHaveLength(0);
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
      );
      expect(rows[0].count).toBe('0');
    });

    it('rejects missing, extra, or empty variables with 400 and no row, audit, or provider call (spec "Placeholder mismatch rejected")', async () => {
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}, tu saldo es {{2}}.');
      // No audit may be written for a rejected request: the audit_logs table
      // is shared across tests, so compare against the pre-call baseline.
      const baseline: { count: string }[] = await dataSource.query(
        "SELECT COUNT(*)::text AS count FROM audit_logs WHERE action = 'whatsapp_dispatch.created'",
      );
      const baselineCount = baseline[0].count;

      await expect(
        service.create(
          {
            patientId: patient.id,
            templateId: template.id,
            variables: { '1': 'Juan' },
          },
          null,
        ),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.create(
          {
            patientId: patient.id,
            templateId: template.id,
            variables: { '1': 'Juan', '2': 'x', '3': 'y' },
          },
          null,
        ),
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.create(
          {
            patientId: patient.id,
            templateId: template.id,
            variables: { '1': '', '2': 'x' },
          },
          null,
        ),
      ).rejects.toThrow(BadRequestException);

      expect(provider.sent).toHaveLength(0);
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
      );
      expect(rows[0].count).toBe('0');
      const after: { count: string }[] = await dataSource.query(
        "SELECT COUNT(*)::text AS count FROM audit_logs WHERE action = 'whatsapp_dispatch.created'",
      );
      expect(after[0].count).toBe(baselineCount);
    });

    it('throws NotFound for an unknown patient', async () => {
      const template = await insertTemplate('Hola {{1}}');

      await expect(
        service.create(
          {
            patientId: '00000000-0000-4000-8000-000000000000',
            templateId: template.id,
            variables: { '1': 'x' },
          },
          null,
        ),
      ).rejects.toThrow(NotFoundException);
      expect(provider.sent).toHaveLength(0);
    });

    it('stores only the resolved variables as payload and the normalized phone snapshot (spec "Non-PII payload and phone snapshot")', async () => {
      const actorId = await insertActor();
      // Legacy 8-digit mobile (no country code): the dispatch snapshot MUST
      // be canonical. uniquePhone() keeps the raw value unique per run since
      // patients are never truncated on the shared db_creditos_test.
      const legacyPhone = uniquePhone();
      const patient = await insertPatient(legacyPhone);
      const template = await insertTemplate('Hola {{1}}');

      const dispatch = await service.create(
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'Juan' },
        },
        actorId,
      );

      const row = await storedDispatch(dispatch.id);
      expect(row?.phone).toBe(`+591${legacyPhone}`);
      expect(row?.payload).toEqual({ '1': 'Juan' });
      // The raw patients.phone stays as provided; only the snapshot is canonical.
      const patientRows: { phone: string }[] = await dataSource.query(
        'SELECT phone FROM patients WHERE id = $1',
        [patient.id],
      );
      expect(patientRows[0].phone).toBe(legacyPhone);
    });

    it('deduplicates identical requests: sequential duplicate gets 409, one row, one provider call (spec "Duplicate dispatch deduplicated")', async () => {
      const actorId = await insertActor();
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');
      const input = {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan' },
      };

      const first = await service.create(input, actorId);
      expect(first.status).toBe(DispatchStatus.SENT);

      await expect(service.create(input, actorId)).rejects.toThrow(
        ConflictException,
      );
      await expect(service.create(input, actorId)).rejects.toThrow(
        'An identical dispatch already exists',
      );

      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
      );
      expect(rows[0].count).toBe('1');
      expect(provider.sent).toHaveLength(1);
    });

    it('deduplicates identical requests even when variable key order differs (canonicalJson stable)', async () => {
      const actorId = await insertActor();
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}} y {{2}}.');

      await service.create(
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'A', '2': 'B' },
        },
        actorId,
      );

      await expect(
        service.create(
          {
            patientId: patient.id,
            templateId: template.id,
            variables: { '2': 'B', '1': 'A' },
          },
          actorId,
        ),
      ).rejects.toThrow(ConflictException);
      expect(provider.sent).toHaveLength(1);
    });

    it('deduplicates two concurrent identical requests into one row and one provider call', async () => {
      const actorId = await insertActor();
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');
      const input = {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan' },
      };

      const results = await Promise.allSettled([
        service.create(input, actorId),
        service.create(input, actorId),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r) => r.status === 'rejected' && r.reason instanceof ConflictException,
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
      );
      expect(rows[0].count).toBe('1');
      expect(provider.sent).toHaveLength(1);
    });

    it('never makes a real network call: fetch is never invoked during dispatch flows (spec "Mock provider isolation")', async () => {
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');

      await service.create(
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'x' },
        },
        null,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe('retry', () => {
    it('retries a failed dispatch through queued to sent with a new wamid and status_changed audits (spec "Failed dispatch retried")', async () => {
      const actorId = await insertActor();
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');
      provider.failNext = true;
      const failed = await service.create(
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'Juan' },
        },
        actorId,
      );
      expect(failed.status).toBe(DispatchStatus.FAILED);

      const retried = await service.retry(failed.id, actorId);

      expect(retried.status).toBe(DispatchStatus.SENT);
      expect(retried.sendAttempts).toBe(2);
      expect(retried.providerMessageId).toMatch(/^wamid\.mock\.\d+$/);
      expect(retried.providerError).toBeNull();
      const row = await storedDispatch(failed.id);
      expect(row?.status).toBe(DispatchStatus.SENT);
      expect(row?.sendAttempts).toBe(2);
      expect(row?.providerMessageId).toMatch(/^wamid\.mock\.\d+$/);
      expect(provider.sent).toHaveLength(1);

      const audits = await auditsFor(failed.id);
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
      expect(statusAudits.every((a) => a.userId === actorId)).toBe(true);
    });

    it('rejects retry of a terminal delivered dispatch with 409 and no provider call (spec "Terminal status cannot be retried")', async () => {
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');
      const dispatch = await service.create(
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'x' },
        },
        null,
      );

      await dataSource.query(
        `UPDATE whatsapp_dispatches
            SET status = $1, provider_message_id = $2
          WHERE id = $3`,
        [DispatchStatus.DELIVERED, 'wamid.delivered.1', dispatch.id],
      );

      const sentBeforeRetry = provider.sent.length;
      await expect(service.retry(dispatch.id, null)).rejects.toThrow(
        ConflictException,
      );
      expect(provider.sent).toHaveLength(sentBeforeRetry);

      const row = await storedDispatch(dispatch.id);
      expect(row?.status).toBe(DispatchStatus.DELIVERED);
      expect(row?.sendAttempts).toBe(1);
    });

    it('rejects retry at the attempt limit with 409 and never violates the send_attempts CHECK (spec "Attempt limit reached")', async () => {
      const actorId = await insertActor();
      const patient = await insertPatient();
      const template = await insertTemplate('Hola {{1}}');
      const input = {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan' },
      };

      // Attempt 1: initial create fails.
      provider.failNext = true;
      const dispatch = await service.create(input, actorId);
      // Attempts 2 and 3: retries fail again.
      provider.failNext = true;
      await service.retry(dispatch.id, actorId);
      provider.failNext = true;
      await service.retry(dispatch.id, actorId);

      let row = await storedDispatch(dispatch.id);
      expect(row?.sendAttempts).toBe(3);
      expect(row?.status).toBe(DispatchStatus.FAILED);

      // Fourth attempt must be rejected by the service gate (never reaches
      // the DB CHECK 23514 — the service guards before incrementing).
      await expect(service.retry(dispatch.id, actorId)).rejects.toThrow(
        ConflictException,
      );

      row = await storedDispatch(dispatch.id);
      expect(row?.sendAttempts).toBe(3);
      expect(row?.status).toBe(DispatchStatus.FAILED);
    });

    it('throws NotFound when retrying an unknown dispatch', async () => {
      await expect(
        service.retry('00000000-0000-4000-8000-000000000000', null),
      ).rejects.toThrow(NotFoundException);
      expect(provider.sent).toHaveLength(0);
    });
  });

  describe('pure placeholder extraction', () => {
    it('extracts contiguous placeholder numbers from a template body', () => {
      expect(
        extractPlaceholderNumbers(
          'Hola {{1}}, tu pago de {{2}} vence el {{3}}.',
        ),
      ).toEqual([1, 2, 3]);
    });

    it('returns an empty list for a body without placeholders', () => {
      expect(
        extractPlaceholderNumbers('Hola, esto es un recordatorio.'),
      ).toEqual([]);
    });
  });
});
