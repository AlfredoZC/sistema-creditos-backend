import { INestApplication } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { TemplateCategory, TemplateStatus } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { MessageTemplate } from './entities';
import { WHATSAPP_PROVIDER } from './whatsapp.module';

jest.setTimeout(60000);

/**
 * Boot smoke for task 2.1 (design §3 + §7): proves AppModule compiles with
 * WhatsappModule wired in, the provider factory resolves to the mock under
 * WHATSAPP_PROVIDER=mock (isolation guarantee — the Meta adapter is never
 * constructed), and the MessageTemplate entity maps migration 003's
 * `message_templates` table 1:1 (snake_case columns, PG enums, jsonb).
 */
describe('WhatsappModule boot (AppModule integration, design §3)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let templateRepository: Repository<MessageTemplate>;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    templateRepository = app.get(getRepositoryToken(MessageTemplate));
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots AppModule with the mock provider (isolation guarantee, spec "Mock provider isolation")', () => {
    const provider = app.get(WHATSAPP_PROVIDER) as { name: string };

    expect(provider.name).toBe('mock');
    // .env.test is the CI contract: without WHATSAPP_PROVIDER=mock the
    // factory would throw on first injection and AppModule could not boot.
    expect(process.env.WHATSAPP_PROVIDER).toBe('mock');
  });

  it('maps message_templates 1:1 to migration 003 via the TypeORM repository', async () => {
    const name = `boot_smoke_${process.pid}_${Date.now()}`;
    const saved = await templateRepository.save(
      templateRepository.create({
        name,
        category: TemplateCategory.UTILITY,
        language: 'es',
        bodyTemplate: 'Hola {{1}}',
        sampleVariables: { '1': 'Mundo' },
        status: TemplateStatus.DRAFT,
        isActive: true,
        createdByUserId: null,
      }),
    );

    const rows: {
      name: string;
      category: string;
      language: string;
      bodyTemplate: string;
      sampleVariables: Record<string, string>;
      status: string;
      isActive: boolean;
    }[] = await dataSource.query(
      `SELECT name,
              category,
              language,
              body_template AS "bodyTemplate",
              sample_variables AS "sampleVariables",
              status,
              is_active AS "isActive"
         FROM message_templates
        WHERE id = $1`,
      [saved.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      name,
      category: TemplateCategory.UTILITY,
      language: 'es',
      bodyTemplate: 'Hola {{1}}',
      sampleVariables: { '1': 'Mundo' },
      status: TemplateStatus.DRAFT,
      isActive: true,
    });

    await templateRepository.delete(saved.id);
  });
});
