import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

interface IdRow {
  id: string;
}

interface RunBody {
  dueSoon: number;
  overdue: number;
  skipped: number;
  failed: number;
}

describe('POST /api/reminders/run', () => {
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

  async function tokenFor(role: UserRole): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, 'hashed-password', $2, $3, true)
       RETURNING id`,
      [
        `reminders.${role}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`,
        `Reminders ${role}`,
        role,
      ],
    );
    return jwtService.sign({ id: rows[0].id });
  }

  it('rejects anonymous access', async () => {
    await request(app.getHttpServer()).post('/api/reminders/run').expect(401);
  });

  // Disparar la corrida manda WhatsApps reales cuando el proveedor es meta:
  // office no alcanza, tiene que ser admin.
  it('rejects the office role', async () => {
    const officeToken = await tokenFor(UserRole.OFFICE);
    await request(app.getHttpServer())
      .post('/api/reminders/run')
      .set('Authorization', `Bearer ${officeToken}`)
      .expect(403);
  });

  it('returns the run counters for an admin', async () => {
    const adminToken = await tokenFor(UserRole.ADMIN);
    const response = await request(app.getHttpServer())
      .post('/api/reminders/run')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const body = response.body as RunBody;
    expect(typeof body.dueSoon).toBe('number');
    expect(typeof body.overdue).toBe('number');
    expect(typeof body.skipped).toBe('number');
    expect(typeof body.failed).toBe('number');
  });
});
