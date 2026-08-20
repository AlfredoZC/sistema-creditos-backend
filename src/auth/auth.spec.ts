import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

const PASSWORD = 'Abc123';
// Unique per-run suffix: the spec never truncates the shared test database,
// so fixed emails would collide with leftovers from a previous run. The pid
// keeps two spec files that start in the same millisecond from colliding.
const EMAIL_SUFFIX = `${process.pid}-${Date.now()}`;

function emailFor(localPart: string): string {
  return `${localPart}.${EMAIL_SUFFIX}@example.com`;
}

interface IdRow {
  id: string;
}

interface RoleRow {
  role: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payloadSegment = token.split('.')[1];
  return JSON.parse(Buffer.from(payloadSegment, 'base64url').toString());
}

function expectTokenCarriesOnlyId(token: string, expectedId: string): void {
  const tokenPayload = decodeJwtPayload(token);
  expect(tokenPayload.id).toBe(expectedId);
  expect(Object.keys(tokenPayload).sort()).toEqual(['exp', 'iat', 'id']);
}

describe('auth API (single-role model, design section 9)', () => {
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

  async function insertUserRaw(
    email: string,
    name: string,
    role: string,
    options: { isActive?: boolean; passwordHash?: string } = {},
  ): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        email,
        options.passwordHash ?? 'hashed-password',
        name,
        role,
        options.isActive ?? true,
      ],
    );
    return rows[0].id;
  }

  async function tokenForUserId(id: string): Promise<string> {
    return jwtService.sign({ id });
  }

  function registerUser(email: string, name: string, extraBody: object = {}) {
    return request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, name, password: PASSWORD, ...extraBody });
  }

  function createStaff(
    token: string,
    email: string,
    name: string,
    role: string,
  ) {
    return request(app.getHttpServer())
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${token}`)
      .send({ email, name, password: PASSWORD, role });
  }

  describe('role-based authorization guard (task 4.2)', () => {
    it('rejects staff creation without a token (401)', async () => {
      const response = await createStaff(
        '',
        emailFor('no.token'),
        'No Token',
        UserRole.OFFICE,
      );

      expect(response.status).toBe(401);
    });

    it('rejects an invalid token on a protected endpoint (401)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/auth/check-status')
        .set('Authorization', 'Bearer not-a-valid-token');

      expect(response.status).toBe(401);
    });

    it('rejects a patient-role user from the admin-only staff endpoint (403)', async () => {
      const patientId = await insertUserRaw(
        emailFor('guard.patient'),
        'Guard Patient',
        UserRole.PATIENT,
      );
      const patientToken = await tokenForUserId(patientId);

      const response = await createStaff(
        patientToken,
        emailFor('office.wannabe'),
        'Office Wannabe',
        UserRole.OFFICE,
      );

      expect(response.status).toBe(403);
    });

    it('rejects an office-role user from the admin-only staff endpoint (403)', async () => {
      const officeId = await insertUserRaw(
        emailFor('guard.office'),
        'Guard Office',
        UserRole.OFFICE,
      );
      const officeToken = await tokenForUserId(officeId);

      const response = await createStaff(
        officeToken,
        emailFor('another.office'),
        'Another Office',
        UserRole.OFFICE,
      );

      expect(response.status).toBe(403);
    });

    it('rejects an inactive user on a protected endpoint (401)', async () => {
      const inactiveId = await insertUserRaw(
        emailFor('guard.inactive'),
        'Guard Inactive',
        UserRole.ADMIN,
        { isActive: false },
      );
      const inactiveToken = await tokenForUserId(inactiveId);

      const response = await request(app.getHttpServer())
        .get('/api/auth/check-status')
        .set('Authorization', `Bearer ${inactiveToken}`);

      expect(response.status).toBe(401);
    });
  });

  describe('public registration (task 4.3)', () => {
    it('creates a user with exactly one role (patient) and an {id} token', async () => {
      const response = await registerUser(emailFor('public.one'), 'Public One');

      expect(response.status).toBe(201);
      expect(response.body.role).toBe(UserRole.PATIENT);
      expect(response.body.password).toBeUndefined();

      const rows: (RoleRow & IdRow)[] = await dataSource.query(
        'SELECT id, role FROM users WHERE email = $1',
        [emailFor('public.one')],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('patient');

      expectTokenCarriesOnlyId(response.body.token as string, rows[0].id);
    });

    it('rejects a role field in the public registration payload (400)', async () => {
      const response = await registerUser(
        emailFor('role.intruder'),
        'Role Intruder',
        {
          role: UserRole.ADMIN,
        },
      );

      expect(response.status).toBe(400);
      expect(response.body.message).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/role should not exist/i),
        ]),
      );
    });

    it('rejects legacy role values on registration (400)', async () => {
      const response = await registerUser(
        emailFor('legacy.register'),
        'Legacy Register',
        {
          role: 'super-user',
        },
      );

      expect(response.status).toBe(400);
      expect(response.body.message).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/role should not exist/i),
        ]),
      );
    });
  });

  describe('login and session (task 4.3)', () => {
    it('logs in an active user and returns an {id} token without the password', async () => {
      await insertUserRaw(
        emailFor('login.user'),
        'Login User',
        UserRole.PATIENT,
        {
          passwordHash: bcrypt.hashSync(PASSWORD, 10),
        },
      );

      const response = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: emailFor('login.user'), password: PASSWORD });

      expect(response.status).toBe(201);
      expect(response.body.password).toBeUndefined();
      expect(response.body.role).toBe(UserRole.PATIENT);

      const rows: IdRow[] = await dataSource.query(
        'SELECT id FROM users WHERE email = $1',
        [emailFor('login.user')],
      );
      expectTokenCarriesOnlyId(response.body.token as string, rows[0].id);
    });

    it('rejects an inactive user on login (401)', async () => {
      await insertUserRaw(
        emailFor('inactive.login'),
        'Inactive Login',
        UserRole.PATIENT,
        {
          isActive: false,
          passwordHash: bcrypt.hashSync(PASSWORD, 10),
        },
      );

      const response = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: emailFor('inactive.login'), password: PASSWORD });

      expect(response.status).toBe(401);
      expect(response.body.message).toMatch(/inactive/i);
    });

    it('re-issues a token for a valid active session via check-status', async () => {
      const userId = await insertUserRaw(
        emailFor('check.status'),
        'Check Status',
        UserRole.PATIENT,
      );
      const sessionToken = await tokenForUserId(userId);

      const response = await request(app.getHttpServer())
        .get('/api/auth/check-status')
        .set('Authorization', `Bearer ${sessionToken}`);

      expect(response.status).toBe(200);
      expect(response.body.email).toBe(emailFor('check.status'));
      expectTokenCarriesOnlyId(response.body.token as string, userId);
    });
  });

  describe('staff account creation (task 4.3)', () => {
    const ADMIN_EMAIL = 'admin.seed@example.com';

    async function adminToken(): Promise<string> {
      const existing: IdRow[] = await dataSource.query(
        'SELECT id FROM users WHERE email = $1',
        [ADMIN_EMAIL],
      );
      if (existing.length === 0) {
        await insertUserRaw(ADMIN_EMAIL, 'Admin Seed', UserRole.ADMIN, {
          passwordHash: bcrypt.hashSync(PASSWORD, 10),
        });
      }
      const loginResponse = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: ADMIN_EMAIL, password: PASSWORD });
      expect(loginResponse.status).toBe(201);
      return loginResponse.body.token as string;
    }

    it('lets an admin create an office account (201) and persists the role', async () => {
      const token = await adminToken();

      const response = await createStaff(
        token,
        emailFor('office.staff'),
        'Office Staff',
        UserRole.OFFICE,
      );

      expect(response.status).toBe(201);
      expect(response.body.role).toBe(UserRole.OFFICE);
      expect(response.body.password).toBeUndefined();

      const rows: RoleRow[] = await dataSource.query(
        'SELECT role FROM users WHERE email = $1',
        [emailFor('office.staff')],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('office');
    });

    it('lets an admin create an admin account (201)', async () => {
      const token = await adminToken();

      const response = await createStaff(
        token,
        emailFor('admin.two'),
        'Admin Two',
        UserRole.ADMIN,
      );

      expect(response.status).toBe(201);
      expect(response.body.role).toBe(UserRole.ADMIN);
    });

    it('rejects a non-staff role on the staff endpoint (400)', async () => {
      const token = await adminToken();

      const response = await createStaff(
        token,
        emailFor('not.staff'),
        'Not Staff',
        UserRole.PATIENT,
      );

      expect(response.status).toBe(400);
      expect(response.body.message).toEqual(
        expect.arrayContaining([expect.stringMatching(/role/i)]),
      );
    });

    it('rejects legacy role values on the staff endpoint (400)', async () => {
      const token = await adminToken();

      const response = await createStaff(
        token,
        emailFor('legacy.staff'),
        'Legacy Staff',
        'super-user',
      );

      expect(response.status).toBe(400);
      expect(response.body.message).toEqual(
        expect.arrayContaining([expect.stringMatching(/role/i)]),
      );
    });
  });
});
