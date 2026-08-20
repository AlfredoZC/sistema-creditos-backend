import { uniqueMobile8 } from '../test-utils/unique-phone';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { TemplateCategory, TemplateStatus, UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { truncateAllTables } from '../test-utils/truncate';
import { MockWhatsAppProvider } from './provider/mock-whatsapp-provider';
import { TemplatesService } from './templates/templates.service';
import { WHATSAPP_PROVIDER } from './whatsapp.module';

jest.setTimeout(60000);

/**
 * Template lifecycle integration spec (task 2.4, design §9.1 + spec
 * "Template Lifecycle"). Proves the provider-driven lifecycle end-to-end on
 * db_creditos_test:
 *
 * - create (draft + `whatsapp_template.created` audit) → submit mirror
 *   (provider event IN_APPROVAL → `submitted` via mirrorProviderStatus) →
 *   approval mirror (APPROVED → `approved`) — proposal success criteria
 *   "create template (submitted→approved mirroring)".
 * - CRUD via HTTP (create/read/update/deactivate).
 * - deactivation blocks dispatch (409) without deleting the row (spec
 *   "Rejected, paused, or deactivated blocked").
 * - placeholder mismatch → 400 with no row, audit, or provider call (spec
 *   "Placeholder mismatch rejected").
 * - audit actions present + zero PII in template audit payloads (AD9).
 *
 * REUSE NOTE (documented): the approval-status mirror is exercised through
 * TemplatesService.mirrorProviderStatus (the PR11 minimal webhook contract) —
 * a service-level call; the HTTP-level mirror is covered by webhook.spec (4.5).
 *
 * DEFERRALS (documented in tasks.md 2.4 note — NOT implemented in this slice):
 * - The submit-on-create provider call (design §9.1 "AFTER commit
 *   provider.submitTemplate") does not exist in production: create persists
 *   `draft` only (PR6 contract, asserted by templates.service.spec). The
 *   mock's `submitted` FIFO is exercised by the provider-layer specs (1.7).
 *   The lifecycle mirror IS proven here: the provider template id is written
 *   directly (simulating the deferred submit persisting Meta's id) and the
 *   provider status events drive status via mirrorProviderStatus.
 * - The utility-only reminder gate (design §9.1 "category='utility' enforced
 *   at dispatch time") does not exist: dispatches.service gates ONLY on
 *   status==='approved' && is_active. Deferred to its owning task.
 */
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

function uniqueIdentityDocument(): string {
  return `${RUN_SUFFIX}${uniqueCounter++}`.slice(-20);
}

// patients.phone is UNIQUE (migration 002); rows are shared with other
// integration suites on db_creditos_test — every insert needs a fresh phone.
function uniquePhone(): string {
  // Delegado al helper compartido: los contadores por archivo colisionaban
  // entre suites al correr todo en un mismo proceso (--runInBand).
  return uniqueMobile8();
}

function emailFor(localPart: string): string {
  return `${localPart}.${RUN_SUFFIX}@example.com`;
}

interface IdRow {
  id: string;
}

interface TemplateRow {
  id: string;
  name: string;
  category: string;
  language: string;
  status: string;
  providerTemplateId: string | null;
  providerStatus: string | null;
  isActive: boolean;
}

interface AuditRow {
  action: string;
  userId: string | null;
  newData: Record<string, unknown> | null;
  previousData: Record<string, unknown> | null;
}

const BODY_THREE_PLACEHOLDERS = 'Hola {{1}}, tu pago de {{2}} vence el {{3}}.';
const BODY_TWO_PLACEHOLDERS = 'Hola {{1}}, tu pago de {{2}}.';
const AUDIT_TEMPLATE_CREATED = 'whatsapp_template.created';
const AUDIT_TEMPLATE_UPDATED = 'whatsapp_template.updated';
const AUDIT_TEMPLATE_STATUS_CHANGED = 'whatsapp_template.status_changed';

describe('Template lifecycle integration (task 2.4, design §9.1 + spec "Template Lifecycle")', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let service: TemplatesService;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
    service = app.get(TemplatesService);
    provider = app.get(WHATSAPP_PROVIDER) as MockWhatsAppProvider;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    // Clean slate between tests: every business table (users, patients,
    // message_templates, whatsapp_dispatches, audit_logs, ...) is truncated.
    await truncateAllTables(dataSource);
    provider.sent.length = 0;
    provider.submitted.length = 0;
    provider.failNext = false;
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
      emailFor(`${label}.templates.lifecycle.${uniqueCounter++}`),
      `Templates ${label}`,
      role,
    );
    return jwtService.sign({ id });
  }

  async function insertPatient(phone?: string): Promise<{
    id: string;
    phone: string;
    identityDocument: string;
  }> {
    const value = phone ?? uniquePhone();
    const identityDocument = uniqueIdentityDocument();
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Lifecycle', 'Patient', $2) RETURNING id`,
      [identityDocument, value],
    );
    return { id: rows[0].id, phone: value, identityDocument };
  }

  /** Raw-SQL approved template (the API cannot land an approved row without
   *  the provider mirror — the mirror itself is what this spec proves). */
  async function insertApprovedTemplate(
    body: string,
    overrides: { category?: string } = {},
  ): Promise<{ id: string; name: string; language: string }> {
    const name = `tpl_${RUN_SUFFIX}_${uniqueCounter++}`;
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO message_templates (name, category, language, body_template, status, is_active)
       VALUES ($1, $2, 'es', $3, 'approved', true) RETURNING id`,
      [name, overrides.category ?? TemplateCategory.UTILITY, body],
    );
    return { id: rows[0].id, name, language: 'es' };
  }

  /** Simulates the deferred submit-on-create persisting Meta's template id
   *  (see header DEFERRALS note): mirrorProviderStatus resolves templates by
   *  provider_template_id, which only the provider submission would set. */
  async function setProviderTemplateId(
    id: string,
    providerTemplateId: string,
  ): Promise<void> {
    await dataSource.query(
      `UPDATE message_templates SET provider_template_id = $1 WHERE id = $2`,
      [providerTemplateId, id],
    );
  }

  function createTemplate(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/whatsapp/templates')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function listTemplates(token: string, query: string = '') {
    return request(app.getHttpServer())
      .get(`/api/whatsapp/templates${query}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function getTemplate(token: string, id: string) {
    return request(app.getHttpServer())
      .get(`/api/whatsapp/templates/${id}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function patchTemplate(
    token: string,
    id: string,
    body: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .patch(`/api/whatsapp/templates/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function deactivateTemplate(token: string, id: string) {
    return request(app.getHttpServer())
      .patch(`/api/whatsapp/templates/${id}/deactivate`)
      .set('Authorization', `Bearer ${token}`);
  }

  function createDispatch(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/whatsapp/dispatches')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function storedTemplate(id: string): Promise<TemplateRow | undefined> {
    const rows: TemplateRow[] = await dataSource.query(
      `SELECT id,
              name,
              category,
              language,
              status,
              provider_template_id AS "providerTemplateId",
              provider_status AS "providerStatus",
              is_active AS "isActive"
         FROM message_templates
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

  /**
   * `created_at` es la hora de la TRANSACCION: dos entradas escritas dentro de
   * la misma transaccion comparten el valor exacto, asi que su orden relativo
   * no esta definido y comparar la secuencia tal cual fallaba de forma
   * intermitente. Lo que el contrato exige es QUE acciones quedaron
   * registradas, no en que orden dentro de una misma transaccion: se comparan
   * como multiconjunto. Una accion faltante o de mas sigue fallando.
   */
  function expectSameAudits(actual: string[], expected: string[]): void {
    expect([...actual].sort()).toEqual([...expected].sort());
  }

  async function dispatchCount(): Promise<string> {
    const rows: { count: string }[] = await dataSource.query(
      'SELECT COUNT(*)::text AS count FROM whatsapp_dispatches',
    );
    return rows[0].count;
  }

  async function dispatchAuditCount(): Promise<string> {
    const rows: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*)::text AS count
         FROM audit_logs
        WHERE action LIKE 'whatsapp_dispatch.%'`,
    );
    return rows[0].count;
  }

  describe('submitted→approved lifecycle mirroring (proposal success criteria "create template (submitted→approved mirroring)")', () => {
    it('create → draft; IN_APPROVAL mirror → submitted; APPROVED mirror → approved; then a dispatch succeeds end-to-end', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const officeId = (jwtService.decode(officeToken) as { id: string }).id;

      // 1. Create: always lands draft with the created audit (PR6 contract).
      const created = await createTemplate(officeToken, {
        name: 'reminder_lifecycle',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: BODY_THREE_PLACEHOLDERS,
        sampleVariables: { '1': 'Juan', '2': 'Bs 100', '3': '2026-08-05' },
      });
      expect(created.status).toBe(201);
      expect(created.body.status).toBe(TemplateStatus.DRAFT);
      expect(created.body.isActive).toBe(true);
      expect(created.body.providerTemplateId).toBeNull();

      let audits = await auditsFor(created.body.id as string);
      expect(audits.map((a) => a.action)).toEqual([AUDIT_TEMPLATE_CREATED]);
      expect(audits[0].userId).toBe(officeId);
      expect(audits[0].newData).toEqual({
        name: 'reminder_lifecycle',
        category: TemplateCategory.UTILITY,
        language: 'es',
        status: TemplateStatus.DRAFT,
      });

      // 2. Submission: the provider accepts the template (Meta template id
      // persisted — see header DEFERRALS note) and emits IN_APPROVAL, which
      // the mirror maps to `submitted` (mapProviderStatusToTemplateStatus).
      await setProviderTemplateId(
        created.body.id as string,
        'template.lifecycle.1',
      );
      const submitted = await service.mirrorProviderStatus(
        'template.lifecycle.1',
        'IN_APPROVAL',
      );
      expect(submitted?.status).toBe(TemplateStatus.SUBMITTED);
      expect(submitted?.providerStatus).toBe('IN_APPROVAL');

      audits = await auditsFor(created.body.id as string);
      expect(audits.map((a) => a.action)).toEqual([
        AUDIT_TEMPLATE_CREATED,
        AUDIT_TEMPLATE_STATUS_CHANGED,
      ]);
      expect(audits[1].userId).toBeNull(); // system event (AD9)
      expect(audits[1].previousData).toEqual({ status: TemplateStatus.DRAFT });
      expect(audits[1].newData).toEqual({
        status: TemplateStatus.SUBMITTED,
        providerStatus: 'IN_APPROVAL',
      });

      // 3. Approval: the provider event APPROVED mirrors onto `approved`
      // (submitted→approved is an allowed mirror edge).
      const approved = await service.mirrorProviderStatus(
        'template.lifecycle.1',
        'APPROVED',
      );
      expect(approved?.status).toBe(TemplateStatus.APPROVED);
      expect(approved?.providerStatus).toBe('APPROVED');

      audits = await auditsFor(created.body.id as string);
      expect(audits.map((a) => a.action)).toEqual([
        AUDIT_TEMPLATE_CREATED,
        AUDIT_TEMPLATE_STATUS_CHANGED,
        AUDIT_TEMPLATE_STATUS_CHANGED,
      ]);
      expect(audits[2].previousData).toEqual({
        status: TemplateStatus.SUBMITTED,
      });
      expect(audits[2].newData).toEqual({
        status: TemplateStatus.APPROVED,
        providerStatus: 'APPROVED',
      });

      // 4. Approved + active ⇒ dispatchable: the full flow closes the loop.
      const patient = await insertPatient();
      const fetchSpy = jest.spyOn(globalThis, 'fetch');
      const dispatched = await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: created.body.id,
        variables: { '1': 'Juan', '2': 'Bs 100', '3': '2026-08-05' },
      });

      expect(dispatched.status).toBe(201);
      expect(dispatched.body.status).toBe('sent');
      expect(provider.name).toBe('mock');
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].input).toEqual({
        to: `+591${patient.phone}`,
        templateName: 'reminder_lifecycle',
        language: 'es',
        variables: [
          { name: '1', value: 'Juan' },
          { name: '2', value: 'Bs 100' },
          { name: '3', value: '2026-08-05' },
        ],
      });
      // Mock isolation: no real network call (spec "Mock provider isolation").
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it('is idempotent: a repeated APPROVED event changes nothing and audits nothing', async () => {
      const template = await insertApprovedTemplate(BODY_TWO_PLACEHOLDERS);
      await dataSource.query(
        `UPDATE message_templates SET provider_template_id = $1 WHERE id = $2`,
        ['template.lifecycle.2', template.id],
      );

      const auditsBefore = (await auditsFor(template.id)).length;
      const result = await service.mirrorProviderStatus(
        'template.lifecycle.2',
        'APPROVED',
      );

      expect(result?.status).toBe(TemplateStatus.APPROVED);
      expect(await auditsFor(template.id)).toHaveLength(auditsBefore);
    });

    it('rejects a regression: APPROVED arriving for a draft is a silent no-op with no audit', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const created = await createTemplate(officeToken, {
        name: 'regression_guard',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: BODY_TWO_PLACEHOLDERS,
      });
      expect(created.status).toBe(201);
      await setProviderTemplateId(
        created.body.id as string,
        'template.lifecycle.3',
      );

      // draft→approved is NOT an allowed transition (only draft→submitted):
      // an out-of-order provider event must not move the template backwards.
      const result = await service.mirrorProviderStatus(
        'template.lifecycle.3',
        'APPROVED',
      );

      expect(result?.status).toBe(TemplateStatus.DRAFT);
      const audits = await auditsFor(created.body.id as string);
      expect(audits.map((a) => a.action)).toEqual([AUDIT_TEMPLATE_CREATED]);
    });
  });

  describe('CRUD via HTTP (spec "Template Lifecycle": create, read, update, deactivate)', () => {
    it('create → list → get :id → PATCH body/samples → manual draft→submitted transition', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const officeId = (jwtService.decode(officeToken) as { id: string }).id;

      const created = await createTemplate(officeToken, {
        name: 'crud_lifecycle',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: BODY_TWO_PLACEHOLDERS,
        sampleVariables: { '1': 'Juan', '2': 'Bs 100' },
      });
      expect(created.status).toBe(201);

      const list = await listTemplates(officeToken);
      expect(list.status).toBe(200);
      expect((list.body as { name: string }[]).map((t) => t.name)).toContain(
        'crud_lifecycle',
      );

      const detail = await getTemplate(officeToken, created.body.id as string);
      expect(detail.status).toBe(200);
      expect(detail.body.status).toBe(TemplateStatus.DRAFT);
      expect(detail.body.bodyTemplate).toBe(BODY_TWO_PLACEHOLDERS);

      // PATCH body + samples: updated audit carries only operational fields.
      const updated = await patchTemplate(
        officeToken,
        created.body.id as string,
        {
          body: 'Nueva plantilla {{1}}.',
          sampleVariables: { '1': 'Cliente' },
        },
      );
      expect(updated.status).toBe(200);
      expect(updated.body.bodyTemplate).toBe('Nueva plantilla {{1}}.');

      // Manual submission transition (draft→submitted is an allowed edge).
      const submitted = await patchTemplate(
        officeToken,
        created.body.id as string,
        { status: TemplateStatus.SUBMITTED },
      );
      expect(submitted.status).toBe(200);
      expect(submitted.body.status).toBe(TemplateStatus.SUBMITTED);

      // update() audits `updated` on every PATCH and adds `status_changed`
      // when the status moves: body PATCH → updated, status PATCH → updated
      // + status_changed.
      const audits = await auditsFor(created.body.id as string);
      expectSameAudits(
        audits.map((a) => a.action),
        [
          AUDIT_TEMPLATE_CREATED,
          AUDIT_TEMPLATE_UPDATED,
          AUDIT_TEMPLATE_UPDATED,
          AUDIT_TEMPLATE_STATUS_CHANGED,
        ],
      );
      expect(audits.every((a) => a.userId === officeId)).toBe(true);
      expect(audits[1].newData).toEqual({
        name: 'crud_lifecycle',
        category: TemplateCategory.UTILITY,
        language: 'es',
        status: TemplateStatus.DRAFT,
      });
      expect(audits[2].newData).toEqual({
        name: 'crud_lifecycle',
        category: TemplateCategory.UTILITY,
        language: 'es',
        status: TemplateStatus.SUBMITTED,
      });
      expect(audits[3].previousData).toEqual({ status: TemplateStatus.DRAFT });
      expect(audits[3].newData).toEqual({
        status: TemplateStatus.SUBMITTED,
      });
    });
  });

  describe('deactivation blocks dispatch (spec "Rejected, paused, or deactivated blocked")', () => {
    it('PATCH :id/deactivate keeps the row with is_active=false + updated audit, then dispatch → 409 with no row or provider call', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const officeId = (jwtService.decode(officeToken) as { id: string }).id;
      const patient = await insertPatient();
      const template = await insertApprovedTemplate(BODY_TWO_PLACEHOLDERS);

      const response = await deactivateTemplate(officeToken, template.id);
      expect(response.status).toBe(200);
      expect(response.body.isActive).toBe(false);

      // Deactivation never deletes the row (design §9.1).
      const row = await storedTemplate(template.id);
      expect(row?.isActive).toBe(false);
      expect(row?.status).toBe(TemplateStatus.APPROVED);

      const audits = await auditsFor(template.id);
      expect(audits.map((a) => a.action)).toEqual([AUDIT_TEMPLATE_UPDATED]);
      expect(audits[0].userId).toBe(officeId);
      expect(audits[0].previousData).toEqual({ isActive: true });
      expect(audits[0].newData).toEqual({ isActive: false });

      const dispatched = await createDispatch(officeToken, {
        patientId: patient.id,
        templateId: template.id,
        variables: { '1': 'Juan', '2': 'Bs 100' },
      });
      expect(dispatched.status).toBe(409);
      expect(dispatched.body.message).toBe(
        'Template is not dispatchable (must be approved and active)',
      );
      expect(await dispatchCount()).toBe('0');
      expect(provider.sent).toHaveLength(0);
    });

    it('rejected, paused, and draft statuses block dispatch with 409 (same gate branch, no row or provider call)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();

      const statuses: TemplateStatus[] = [
        TemplateStatus.REJECTED,
        TemplateStatus.PAUSED,
        TemplateStatus.DRAFT,
      ];
      for (const status of statuses) {
        const name = `tpl_gate_${status}_${RUN_SUFFIX}_${uniqueCounter++}`;
        const rows: IdRow[] = await dataSource.query(
          `INSERT INTO message_templates (name, category, language, body_template, status, is_active)
           VALUES ($1, 'utility', 'es', $2, $3, true) RETURNING id`,
          [name, BODY_TWO_PLACEHOLDERS, status],
        );
        const dispatched = await createDispatch(officeToken, {
          patientId: patient.id,
          templateId: rows[0].id,
          variables: { '1': 'Juan', '2': 'Bs 100' },
        });
        expect(dispatched.status).toBe(409);
      }

      expect(await dispatchCount()).toBe('0');
      expect(provider.sent).toHaveLength(0);
    });
  });

  describe('placeholder mismatch rejected (spec "Placeholder mismatch rejected")', () => {
    it('missing, extra, and empty variables → 400 with no row, audit, or provider call', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();
      const template = await insertApprovedTemplate(BODY_TWO_PLACEHOLDERS);

      const cases: Record<string, unknown>[] = [
        // Missing {{2}}.
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'Juan' },
        },
        // Extra variable beyond {{1}}..{{2}}.
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'Juan', '2': 'Bs 100', '3': 'extra' },
        },
        // Empty substitution for {{2}}.
        {
          patientId: patient.id,
          templateId: template.id,
          variables: { '1': 'Juan', '2': '' },
        },
      ];

      for (const payload of cases) {
        const response = await createDispatch(officeToken, payload);
        expect(response.status).toBe(400);
      }

      // 400 happens BEFORE any row, audit, or provider call (spec scenario).
      expect(await dispatchCount()).toBe('0');
      expect(await dispatchAuditCount()).toBe('0');
      expect(provider.sent).toHaveLength(0);
    });
  });

  describe('audit contract: actions present + no PII in template audit payloads (AD9)', () => {
    it('full lifecycle audits only whatsapp_template.created/updated/status_changed with operational fields only', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const patient = await insertPatient();

      // Drive the complete lifecycle: create → submit mirror → approval
      // mirror → PATCH body → deactivate.
      const created = await createTemplate(officeToken, {
        name: 'pii_guard',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: BODY_TWO_PLACEHOLDERS,
        sampleVariables: { '1': 'Juan', '2': 'Bs 100' },
      });
      expect(created.status).toBe(201);
      await setProviderTemplateId(created.body.id as string, 'template.pii.1');
      await service.mirrorProviderStatus('template.pii.1', 'IN_APPROVAL');
      await service.mirrorProviderStatus('template.pii.1', 'APPROVED');
      await patchTemplate(officeToken, created.body.id as string, {
        body: 'Cuerpo actualizado {{1}} {{2}}',
      });
      await deactivateTemplate(officeToken, created.body.id as string);

      const audits = await auditsFor(created.body.id as string);
      const actions = audits.map((a) => a.action);
      expectSameAudits(actions, [
        AUDIT_TEMPLATE_CREATED,
        AUDIT_TEMPLATE_STATUS_CHANGED,
        AUDIT_TEMPLATE_STATUS_CHANGED,
        AUDIT_TEMPLATE_UPDATED,
        AUDIT_TEMPLATE_UPDATED,
      ]);
      // The full required vocabulary appears; nothing else (AD8 vocabulary).
      expect(actions).toEqual(
        expect.arrayContaining([
          AUDIT_TEMPLATE_CREATED,
          AUDIT_TEMPLATE_UPDATED,
          AUDIT_TEMPLATE_STATUS_CHANGED,
        ]),
      );

      // Manual operations carry the acting office user; provider events are
      // system events with user_id NULL (spec "Actor vs system attribution").
      expect(audits[0].userId).not.toBeNull();
      expect(audits[3].userId).not.toBeNull();
      expect(audits[4].userId).not.toBeNull();
      expect(audits[1].userId).toBeNull();
      expect(audits[2].userId).toBeNull();

      // AD9: audit JSONB carries ONLY operational fields — never the patient
      // phone, the identity document, message/template bodies, or sample
      // values. Serialize everything and scan for each PII marker.
      const serialized = audits
        .map((a) => JSON.stringify([a.newData, a.previousData]))
        .join('|');
      expect(serialized).not.toContain(patient.phone);
      expect(serialized).not.toContain(patient.identityDocument);
      expect(serialized).not.toContain('Juan');
      expect(serialized).not.toContain('Bs 100');
      expect(serialized).not.toContain('Hola');
      expect(serialized).not.toContain('Cuerpo actualizado');
      expect(serialized).not.toContain('{{1}}');
    });
  });
});
