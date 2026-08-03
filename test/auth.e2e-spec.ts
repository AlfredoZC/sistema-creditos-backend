import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../src/common/enums';
import { ensureTestDbReady } from '../src/test-utils/setup-test-db';
import { buildTestingApp } from '../src/test-utils/test-app';

jest.setTimeout(60000);

const PASSWORD = 'Abc123';
// Unique per-run suffix: the e2e spec never truncates the shared test database.
const EMAIL_SUFFIX = `${process.pid}-${Date.now()}`;

describe('auth flow (e2e): register -> login -> check-status -> staff role guard', () => {
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

  it('registers a patient, logs in, and re-validates the session via check-status', async () => {
    const email = `e2e.patient.${EMAIL_SUFFIX}@example.com`;

    const registerResponse = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, name: 'E2E Patient', password: PASSWORD })
      .expect(201);
    expect(registerResponse.body.role).toBe(UserRole.PATIENT);

    const loginResponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    expect(loginResponse.body.email).toBe(email);
    expect(loginResponse.body.password).toBeUndefined();

    const checkStatusResponse = await request(app.getHttpServer())
      .get('/api/auth/check-status')
      .set('Authorization', `Bearer ${loginResponse.body.token}`)
      .expect(200);
    expect(checkStatusResponse.body.email).toBe(email);
  });

  it('enforces the admin role on staff creation across the full HTTP stack', async () => {
    const adminEmail = `e2e.admin.${EMAIL_SUFFIX}@example.com`;
    const patientEmail = `e2e.guard.patient.${EMAIL_SUFFIX}@example.com`;
    const officeEmail = `e2e.office.created.${EMAIL_SUFFIX}@example.com`;
    const anotherOfficeEmail = `e2e.another.office.${EMAIL_SUFFIX}@example.com`;

    // A patient cannot create office accounts.
    const patientResponse = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: patientEmail, name: 'E2E Guard Patient', password: PASSWORD })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${patientResponse.body.token}`)
      .send({ email: officeEmail, name: 'E2E Office', password: PASSWORD, role: UserRole.OFFICE })
      .expect(403);

    // An admin (seeded directly) can create office accounts.
    await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminEmail, bcrypt.hashSync(PASSWORD, 10), 'E2E Admin', UserRole.ADMIN, true],
    );
    const adminLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: adminEmail, password: PASSWORD })
      .expect(201);
    const createdResponse = await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${adminLogin.body.token}`)
      .send({ email: officeEmail, name: 'E2E Office', password: PASSWORD, role: UserRole.OFFICE })
      .expect(201);
    expect(createdResponse.body.role).toBe(UserRole.OFFICE);

    // The created office user still cannot create further office accounts.
    const officeLogin = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: officeEmail, password: PASSWORD })
      .expect(201);
    await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${officeLogin.body.token}`)
      .send({ email: anotherOfficeEmail, name: 'E2E Another Office', password: PASSWORD, role: UserRole.OFFICE })
      .expect(403);
  });
});
