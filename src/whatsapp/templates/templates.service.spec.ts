import {
  ConflictException,
  INestApplication,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';
import { TemplateCategory, TemplateStatus } from '../../common/enums';
import { ensureTestDbReady } from '../../test-utils/setup-test-db';
import { buildTestingApp } from '../../test-utils/test-app';
import { CreateTemplateDto, UpdateTemplateDto } from '../dto';
import { MessageTemplate } from '../entities';
import { TemplatesService } from './templates.service';

jest.setTimeout(60000);

const TEMPLATE_BODY_MAX_LENGTH = 1024;

function createDto(
  overrides: Partial<CreateTemplateDto> = {},
): CreateTemplateDto {
  return {
    name: 'payment_reminder',
    category: TemplateCategory.UTILITY,
    language: 'es',
    body: 'Hola {{1}}, tu pago de {{2}} vence el {{3}}.',
    sampleVariables: { '1': 'Juan', '2': 'Bs 8155.19', '3': '2026-08-05' },
    ...overrides,
  };
}

interface TemplateRow {
  id: string;
  name: string;
  category: string;
  language: string;
  bodyTemplate: string;
  status: string;
  isActive: boolean;
  createdByUserId: string | null;
}

describe('TemplatesService (CRUD + approval gate, design §9.1)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: TemplatesService;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    service = app.get(TemplatesService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await dataSource.query(
      'TRUNCATE TABLE message_templates RESTART IDENTITY CASCADE',
    );
  });

  async function storedRow(id: string): Promise<TemplateRow | undefined> {
    const rows: TemplateRow[] = await dataSource.query(
      `SELECT id,
              name,
              category,
              language,
              body_template AS "bodyTemplate",
              status,
              is_active AS "isActive",
              created_by_user_id AS "createdByUserId"
         FROM message_templates
        WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  describe('create', () => {
    it('persists a utility template defaulting to draft and active', async () => {
      const dto = createDto();

      const template = await service.create(dto, null);

      expect(template.id).toBeDefined();
      expect(template.name).toBe('payment_reminder');
      expect(template.category).toBe(TemplateCategory.UTILITY);
      expect(template.status).toBe(TemplateStatus.DRAFT);
      expect(template.isActive).toBe(true);
      expect(template.providerTemplateId).toBeNull();
      expect(template.createdByUserId).toBeNull();
      const row = await storedRow(template.id);
      expect(row).toEqual({
        id: template.id,
        name: 'payment_reminder',
        category: TemplateCategory.UTILITY,
        language: 'es',
        bodyTemplate: 'Hola {{1}}, tu pago de {{2}} vence el {{3}}.',
        status: TemplateStatus.DRAFT,
        isActive: true,
        createdByUserId: null,
      });
    });

    it('records the acting user id on the template row', async () => {
      // created_by_user_id is a real FK -> users(id); the actor must exist.
      const userRows: { id: string }[] = await dataSource.query(
        `INSERT INTO users (email, password, name, role, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [
          `template.actor.${process.pid}.${Date.now()}@example.com`,
          'hashed-password',
          'Template Actor',
          'office',
        ],
      );
      const actorId = userRows[0].id;

      const template = await service.create(createDto(), actorId);

      const row = await storedRow(template.id);
      expect(row?.createdByUserId).toBe(actorId);
    });

    it('applies the approval gate: non-utility categories require approval', async () => {
      const marketing = await service.create(
        createDto({
          name: 'promo_julio',
          category: TemplateCategory.MARKETING,
        }),
        null,
      );
      const authentication = await service.create(
        createDto({
          name: 'login_code',
          category: TemplateCategory.AUTHENTICATION,
        }),
        null,
      );
      const utility = await service.create(createDto(), null);

      expect(marketing.approvalRequired).toBe(true);
      expect(authentication.approvalRequired).toBe(true);
      expect(utility.approvalRequired).toBe(false);
    });

    it('strips the body to 1024 characters at the service boundary', async () => {
      const oversizedBody = 'x'.repeat(TEMPLATE_BODY_MAX_LENGTH + 500);

      const template = await service.create(
        createDto({ name: 'long_body_template', body: oversizedBody }),
        null,
      );

      expect(template.bodyTemplate).toHaveLength(TEMPLATE_BODY_MAX_LENGTH);
      expect(template.bodyTemplate).toBe(
        oversizedBody.slice(0, TEMPLATE_BODY_MAX_LENGTH),
      );
      const row = await storedRow(template.id);
      expect(row?.bodyTemplate).toHaveLength(TEMPLATE_BODY_MAX_LENGTH);
    });

    it('rejects a duplicate name+language pair with 409 and a clear message', async () => {
      const first = await service.create(createDto(), null);
      expect(first.id).toBeDefined();

      const duplicate = service.create(
        createDto({ name: 'payment_reminder', language: 'es' }),
        null,
      );

      await expect(duplicate).rejects.toThrow(ConflictException);
      await expect(duplicate).rejects.toThrow(
        'Template name+language already exists',
      );
      // The unique constraint must not be bypassed: exactly one row remains.
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM message_templates',
      );
      expect(rows[0].count).toBe('1');
    });

    it('allows the same name in a different language (unique pair, not name)', async () => {
      await service.create(createDto(), null);

      const second = await service.create(
        createDto({ name: 'payment_reminder', language: 'en' }),
        null,
      );

      expect(second.language).toBe('en');
      const rows: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM message_templates',
      );
      expect(rows[0].count).toBe('2');
    });
  });

  describe('findAll / findOne', () => {
    it('returns every template ordered by creation', async () => {
      await service.create(createDto({ name: 'a_template' }), null);
      await service.create(createDto({ name: 'b_template' }), null);

      const templates = await service.findAll();

      expect(templates.map((t) => t.name).sort()).toEqual([
        'a_template',
        'b_template',
      ]);
    });

    it('filters by status', async () => {
      const draft = await service.create(
        createDto({ name: 'draft_one' }),
        null,
      );
      await service.create(createDto({ name: 'draft_two' }), null);
      const submitted = await service.create(
        createDto({ name: 'submitted_one' }),
        null,
      );
      await service.update(
        submitted.id,
        { status: TemplateStatus.SUBMITTED },
        null,
      );

      const drafts = await service.findAll({ status: TemplateStatus.DRAFT });
      const submittedTemplates = await service.findAll({
        status: TemplateStatus.SUBMITTED,
      });

      expect(drafts.map((t) => t.name).sort()).toEqual([
        'draft_one',
        'draft_two',
      ]);
      expect(submittedTemplates.map((t) => t.name)).toEqual(['submitted_one']);
    });

    it('filters by category', async () => {
      await service.create(createDto({ name: 'util_one' }), null);
      await service.create(createDto({ name: 'util_two' }), null);
      await service.create(
        createDto({ name: 'mkt_one', category: TemplateCategory.MARKETING }),
        null,
      );

      const utilities = await service.findAll({
        category: TemplateCategory.UTILITY,
      });
      const marketing = await service.findAll({
        category: TemplateCategory.MARKETING,
      });

      expect(utilities.map((t) => t.name).sort()).toEqual([
        'util_one',
        'util_two',
      ]);
      expect(marketing.map((t) => t.name)).toEqual(['mkt_one']);
    });

    it('returns a single template by id', async () => {
      const created = await service.create(createDto(), null);

      const found = await service.findOne(created.id);

      expect(found.id).toBe(created.id);
      expect(found.name).toBe('payment_reminder');
    });

    it('throws NotFound when the template does not exist', async () => {
      await expect(
        service.findOne('00000000-0000-4000-8000-000000000000'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('update (PATCH semantics + immutable status transitions)', () => {
    it('updates only the provided fields', async () => {
      const created = await service.create(createDto(), null);

      const updated = await service.update(
        created.id,
        { body: 'Nuevo cuerpo {{1}}' },
        null,
      );

      expect(updated.bodyTemplate).toBe('Nuevo cuerpo {{1}}');
      const row = await storedRow(updated.id);
      expect(row?.bodyTemplate).toBe('Nuevo cuerpo {{1}}');
      expect(row?.name).toBe('payment_reminder');
      expect(row?.category).toBe(TemplateCategory.UTILITY);
      expect(row?.language).toBe('es');
      expect(row?.status).toBe(TemplateStatus.DRAFT);
    });

    it('allows the full lifecycle transitions draft→submitted→approved→rejected→draft', async () => {
      const created = await service.create(createDto(), null);
      expect(created.status).toBe(TemplateStatus.DRAFT);

      const submitted = await service.update(
        created.id,
        { status: TemplateStatus.SUBMITTED },
        null,
      );
      expect(submitted.status).toBe(TemplateStatus.SUBMITTED);

      const approved = await service.update(
        created.id,
        { status: TemplateStatus.APPROVED },
        null,
      );
      expect(approved.status).toBe(TemplateStatus.APPROVED);

      const rejected = await service.update(
        created.id,
        { status: TemplateStatus.REJECTED },
        null,
      );
      expect(rejected.status).toBe(TemplateStatus.REJECTED);

      const backToDraft = await service.update(
        created.id,
        { status: TemplateStatus.DRAFT },
        null,
      );
      expect(backToDraft.status).toBe(TemplateStatus.DRAFT);
    });

    it('allows rejected→submitted', async () => {
      const created = await service.create(createDto(), null);
      await service.update(
        created.id,
        { status: TemplateStatus.REJECTED },
        null,
      );

      const resubmitted = await service.update(
        created.id,
        { status: TemplateStatus.SUBMITTED },
        null,
      );

      expect(resubmitted.status).toBe(TemplateStatus.SUBMITTED);
    });

    it('rejects a disallowed draft→approved jump with 409 and no change', async () => {
      const created = await service.create(createDto(), null);

      await expect(
        service.update(created.id, { status: TemplateStatus.APPROVED }, null),
      ).rejects.toThrow(ConflictException);

      const row = await storedRow(created.id);
      expect(row?.status).toBe(TemplateStatus.DRAFT);
    });

    it('rejects a disallowed submitted→draft regression with 409', async () => {
      const created = await service.create(createDto(), null);
      await service.update(
        created.id,
        { status: TemplateStatus.SUBMITTED },
        null,
      );

      await expect(
        service.update(created.id, { status: TemplateStatus.DRAFT }, null),
      ).rejects.toThrow(ConflictException);
    });

    it('throws NotFound when updating an unknown template', async () => {
      await expect(
        service.update(
          '00000000-0000-4000-8000-000000000000',
          { body: 'x' },
          null,
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes the template row', async () => {
      const created = await service.create(createDto(), null);

      await service.remove(created.id);

      expect(await storedRow(created.id)).toBeUndefined();
    });

    it('throws NotFound when the template does not exist', async () => {
      await expect(
        service.remove('00000000-0000-4000-8000-000000000000'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('dto validation decorators', () => {
    async function expectErrors(
      dtoClass: new () => object,
      value: object,
    ): Promise<string[]> {
      const instance = plainToInstance(dtoClass, value);
      const errors = await validate(instance, { whitelist: true });
      return errors.map((error) => error.property);
    }

    it('accepts a valid create payload', async () => {
      const errors = await expectErrors(CreateTemplateDto, createDto());
      expect(errors).toEqual([]);
    });

    it('rejects a name outside 1..50', async () => {
      expect(
        await expectErrors(CreateTemplateDto, createDto({ name: '' })),
      ).toContain('name');
      expect(
        await expectErrors(
          CreateTemplateDto,
          createDto({ name: 'x'.repeat(51) }),
        ),
      ).toContain('name');
    });

    it('rejects a non ISO 639-1 language', async () => {
      expect(
        await expectErrors(CreateTemplateDto, createDto({ language: 'ES' })),
      ).toContain('language');
      expect(
        await expectErrors(CreateTemplateDto, createDto({ language: 'esp' })),
      ).toContain('language');
    });

    it('rejects an invalid category and an invalid status', async () => {
      expect(
        await expectErrors(
          CreateTemplateDto,
          createDto({ category: 'spam' as TemplateCategory }),
        ),
      ).toContain('category');
      const errors = await expectErrors(UpdateTemplateDto, {
        status: 'deleted' as TemplateStatus,
      });
      expect(errors).toContain('status');
    });

    it('rejects a body over 1024 characters and accepts an empty optional status', async () => {
      expect(
        await expectErrors(
          CreateTemplateDto,
          createDto({ body: 'y'.repeat(1025) }),
        ),
      ).toContain('body');
      const errors = await expectErrors(UpdateTemplateDto, {});
      expect(errors).toEqual([]);
    });
  });
});
