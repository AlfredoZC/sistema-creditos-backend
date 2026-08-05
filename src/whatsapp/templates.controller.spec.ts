import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import {
  TemplateCategory,
  TemplateStatus,
  UserRole,
} from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

// Unique data per run: the suite truncates message_templates, but user rows
// are shared with other integration suites on db_creditos_test, so every
// email carries a per-run suffix (pid + timestamp) — the shared convention.
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

function emailFor(localPart: string): string {
  return `${localPart}.${RUN_SUFFIX}@example.com`;
}

interface IdRow {
  id: string;
}

interface TemplateRow {
  name: string;
  category: string;
  language: string;
  body_template: string;
  status: string;
  is_active: boolean;
  created_by_user_id: string | null;
}

interface CreatedTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  language: string;
  bodyTemplate: string;
  status: TemplateStatus;
  isActive: boolean;
  createdByUserId: string | null;
}

const TEMPLATE_BODY = 'Hola {{1}}, tu pago de {{2}} vence el {{3}}.';

/**
 * TemplatesController endpoint contract (task 2.3, design §9.1): POST create,
 * GET list with status/category filters, GET :id, PATCH :id, PATCH
 * :id/deactivate — all under @Auth(UserRole.OFFICE, UserRole.ADMIN), so
 * office/admin get 2xx and a patient gets 403 (spec role guard).
 */
describe('TemplatesController (HTTP contract, design §9.1)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE message_templates RESTART IDENTITY CASCADE',
    );
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
      emailFor(`${label}.templates.${uniqueCounter++}`),
      `Templates ${label}`,
      role,
    );
    return jwtService.sign({ id });
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

  function updateTemplate(token: string, id: string, body: Record<string, unknown>) {
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

  async function templateRow(id: string): Promise<TemplateRow | undefined> {
    const rows: TemplateRow[] = await dataSource.query(
      `SELECT name,
              category,
              language,
              body_template,
              status,
              is_active,
              created_by_user_id
         FROM message_templates
        WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  describe('POST /api/whatsapp/templates', () => {
    it('creates a template and returns the persisted entity with 201 (office)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const officeId = (jwtService.decode(officeToken) as { id: string }).id;

      const response = await createTemplate(officeToken, {
        name: 'payment_reminder',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
        sampleVariables: { '1': 'Juan', '2': 'Bs 8155.19', '3': '2026-08-05' },
      });

      expect(response.status).toBe(201);
      const created = response.body as CreatedTemplate;
      expect(created.id).toBeDefined();
      expect(created.name).toBe('payment_reminder');
      expect(created.category).toBe(TemplateCategory.UTILITY);
      expect(created.language).toBe('es');
      expect(created.bodyTemplate).toBe(TEMPLATE_BODY);
      expect(created.status).toBe(TemplateStatus.DRAFT);
      expect(created.isActive).toBe(true);
      expect(created.createdByUserId).toBe(officeId);

      const row = await templateRow(created.id);
      expect(row?.name).toBe('payment_reminder');
      expect(row?.category).toBe(TemplateCategory.UTILITY);
      expect(row?.status).toBe(TemplateStatus.DRAFT);
      expect(row?.is_active).toBe(true);
      expect(row?.created_by_user_id).toBe(officeId);
    });

    it('rejects an invalid payload with 400', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');

      const response = await createTemplate(officeToken, {
        name: 'payment_reminder',
        category: 'spam',
        language: 'es',
        body: TEMPLATE_BODY,
      });

      expect(response.status).toBe(400);
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM message_templates',
      );
      expect(rows[0].count).toBe('0');
    });
  });

  describe('GET /api/whatsapp/templates', () => {
    it('lists every template for an office user (200)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const first = await createTemplate(officeToken, {
        name: 'reminder_one',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });
      await createTemplate(officeToken, {
        name: 'promo_one',
        category: TemplateCategory.MARKETING,
        language: 'es',
        body: 'Promo {{1}}',
      });

      const response = await listTemplates(officeToken);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      const names = (response.body as { name: string }[]).map((t) => t.name);
      expect(names).toContain('reminder_one');
      expect(names).toContain('promo_one');
      expect((response.body as { id: string }[]).map((t) => t.id)).toContain(
        first.body.id as string,
      );
    });

    it('filters by status (200, only matching templates)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      await createTemplate(officeToken, {
        name: 'draft_one',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });
      await createTemplate(officeToken, {
        name: 'draft_two',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });
      const submitted = await createTemplate(officeToken, {
        name: 'submitted_one',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });
      const updated = await updateTemplate(officeToken, submitted.body.id as string, {
        status: TemplateStatus.SUBMITTED,
      });
      expect(updated.status).toBe(200);

      const drafts = await listTemplates(
        officeToken,
        `?status=${TemplateStatus.DRAFT}`,
      );
      const submittedList = await listTemplates(
        officeToken,
        `?status=${TemplateStatus.SUBMITTED}`,
      );

      expect(drafts.status).toBe(200);
      expect(
        (drafts.body as { name: string }[]).map((t) => t.name).sort(),
      ).toEqual(['draft_one', 'draft_two']);
      expect(submittedList.status).toBe(200);
      expect((submittedList.body as { name: string }[]).map((t) => t.name)).toEqual([
        'submitted_one',
      ]);
    });

    it('filters by category (200, only matching templates)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      await createTemplate(officeToken, {
        name: 'util_filter',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });
      const marketing = await createTemplate(officeToken, {
        name: 'mkt_filter',
        category: TemplateCategory.MARKETING,
        language: 'es',
        body: 'Promo {{1}}',
      });

      const marketingList = await listTemplates(
        officeToken,
        `?category=${TemplateCategory.MARKETING}`,
      );

      expect(marketingList.status).toBe(200);
      const ids = (marketingList.body as { id: string }[]).map((t) => t.id);
      expect(ids).toEqual([marketing.body.id]);
    });

    it('rejects an invalid filter value with 400', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');

      const response = await listTemplates(officeToken, '?status=deleted');

      expect(response.status).toBe(400);
    });
  });

  describe('GET /api/whatsapp/templates/:id', () => {
    it('returns the template detail (200)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const created = await createTemplate(officeToken, {
        name: 'detail_one',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });

      const response = await getTemplate(officeToken, created.body.id as string);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.id);
      expect(response.body.name).toBe('detail_one');
    });

    it('returns 404 for an unknown template id', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');

      const response = await getTemplate(
        officeToken,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/whatsapp/templates/:id', () => {
    it('applies a partial update and returns the updated entity (200)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const created = await createTemplate(officeToken, {
        name: 'patch_me',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });

      const response = await updateTemplate(officeToken, created.body.id as string, {
        body: 'Nuevo cuerpo {{1}}',
      });

      expect(response.status).toBe(200);
      expect(response.body.bodyTemplate).toBe('Nuevo cuerpo {{1}}');
      const row = await templateRow(created.body.id as string);
      expect(row?.body_template).toBe('Nuevo cuerpo {{1}}');
      expect(row?.name).toBe('patch_me');
      expect(row?.status).toBe(TemplateStatus.DRAFT);
    });

    it('returns 404 when patching an unknown template', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');

      const response = await updateTemplate(
        officeToken,
        '00000000-0000-4000-8000-000000000000',
        { body: 'x {{1}}' },
      );

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /api/whatsapp/templates/:id/deactivate', () => {
    it('sets is_active=false on the row without deleting it (200)', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const created = await createTemplate(officeToken, {
        name: 'deactivate_me',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });

      const response = await deactivateTemplate(
        officeToken,
        created.body.id as string,
      );

      expect(response.status).toBe(200);
      expect(response.body.isActive).toBe(false);
      const row = await templateRow(created.body.id as string);
      expect(row?.is_active).toBe(false);
      expect(row?.name).toBe('deactivate_me');
      // Deactivation never deletes the row (design §9.1).
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM message_templates',
      );
      expect(rows[0].count).toBe('1');
    });

    it('is idempotent: deactivating an inactive template still answers 200', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');
      const created = await createTemplate(officeToken, {
        name: 'double_deactivate',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });
      const first = await deactivateTemplate(officeToken, created.body.id as string);
      expect(first.status).toBe(200);

      const second = await deactivateTemplate(
        officeToken,
        created.body.id as string,
      );

      expect(second.status).toBe(200);
      expect(second.body.isActive).toBe(false);
    });

    it('returns 404 for an unknown template id', async () => {
      const officeToken = await roleToken(UserRole.OFFICE, 'office');

      const response = await deactivateTemplate(
        officeToken,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(response.status).toBe(404);
    });
  });

  describe('role guard (@Auth(OFFICE, ADMIN))', () => {
    it('lets an admin user create and list templates (2xx)', async () => {
      const adminToken = await roleToken(UserRole.ADMIN, 'admin');

      const created = await createTemplate(adminToken, {
        name: 'admin_template',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });
      const list = await listTemplates(adminToken);

      expect(created.status).toBe(201);
      expect(list.status).toBe(200);
    });

    it('rejects a patient on every endpoint with 403', async () => {
      const patientToken = await roleToken(UserRole.PATIENT, 'patient');

      const create = await createTemplate(patientToken, {
        name: 'patient_attempt',
        category: TemplateCategory.UTILITY,
        language: 'es',
        body: TEMPLATE_BODY,
      });
      const list = await listTemplates(patientToken);
      const get = await getTemplate(
        patientToken,
        '00000000-0000-4000-8000-000000000000',
      );
      const patch = await updateTemplate(
        patientToken,
        '00000000-0000-4000-8000-000000000000',
        { body: 'x {{1}}' },
      );
      const deactivate = await deactivateTemplate(
        patientToken,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(create.status).toBe(403);
      expect(list.status).toBe(403);
      expect(get.status).toBe(403);
      expect(patch.status).toBe(403);
      expect(deactivate.status).toBe(403);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/whatsapp/templates',
      );

      expect(response.status).toBe(401);
    });
  });
});
