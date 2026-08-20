import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

// The spec shares db_creditos_test with other integration suites that run in
// parallel (npm test), so it never truncates. Every method name and email
// carries a per-run suffix (pid + timestamp), matching the unique-data
// convention of the other integration specs. The seeded methods (cash,
// bank_transfer, qr, card) are read-only fixtures created by migration 002.
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

function uniqueMethodName(): string {
  return `wallet-${RUN_SUFFIX}-${uniqueCounter++}`;
}

function emailFor(localPart: string): string {
  return `${localPart}.${RUN_SUFFIX}@example.com`;
}

interface IdRow {
  id: string;
}

interface MethodRow {
  name: string;
  is_enabled: boolean;
  description: string | null;
}

describe('payment methods API (design sections 5.10 and 11)', () => {
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
  ): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING id`,
      [email, 'hashed-password', name, role],
    );
    return rows[0].id;
  }

  async function tokenForUserId(id: string): Promise<string> {
    return jwtService.sign({ id });
  }

  async function roleToken(role: UserRole, label: string): Promise<string> {
    const id = await insertUserRaw(
      emailFor(`${label}.methods.${uniqueCounter++}`),
      `Method ${label}`,
      role,
    );
    return tokenForUserId(id);
  }

  function createMethod(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/payment-methods')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function listMethods(token: string) {
    return request(app.getHttpServer())
      .get('/api/payment-methods')
      .set('Authorization', `Bearer ${token}`);
  }

  function updateMethod(
    token: string,
    id: string,
    body: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .patch(`/api/payment-methods/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function methodRow(id: string): Promise<MethodRow> {
    const rows: MethodRow[] = await dataSource.query(
      `SELECT name, is_enabled, description FROM payment_methods WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  describe('payment method reads (any authenticated role, enabled only)', () => {
    it('lists the four seeded methods for an office user', async () => {
      const token = await roleToken(UserRole.OFFICE, 'office');

      const response = await listMethods(token);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
      const names = (response.body as { name: string }[]).map((m) => m.name);
      expect(names).toContain('cash');
      expect(names).toContain('bank_transfer');
      expect(names).toContain('qr');
      expect(names).toContain('card');
      for (const method of response.body as { isEnabled: boolean }[]) {
        expect(method.isEnabled).toBe(true);
      }
    });

    it('lets patient and doctor roles read the enabled methods', async () => {
      const patient = await roleToken(UserRole.PATIENT, 'patient');
      const doctor = await roleToken(UserRole.DOCTOR, 'doctor');

      const patientList = await listMethods(patient);
      const doctorList = await listMethods(doctor);

      expect(patientList.status).toBe(200);
      expect(
        (patientList.body as { name: string }[]).map((m) => m.name),
      ).toContain('cash');
      expect(doctorList.status).toBe(200);
      expect(
        (doctorList.body as { name: string }[]).map((m) => m.name),
      ).toContain('bank_transfer');
    });

    it('hides a disabled method from the list and shows it again after re-enabling', async () => {
      const office = await roleToken(UserRole.OFFICE, 'office');
      const patient = await roleToken(UserRole.PATIENT, 'patient');
      const name = uniqueMethodName();
      const created = await createMethod(office, { name });
      expect(created.status).toBe(201);

      const disabled = await updateMethod(office, created.body.id as string, {
        isEnabled: false,
      });
      expect(disabled.status).toBe(200);

      const afterDisable = await listMethods(patient);
      expect(afterDisable.status).toBe(200);
      const namesAfterDisable = (afterDisable.body as { name: string }[]).map(
        (m) => m.name,
      );
      expect(namesAfterDisable).not.toContain(name);
      const row = await methodRow(created.body.id as string);
      expect(row.is_enabled).toBe(false);

      const reEnabled = await updateMethod(office, created.body.id as string, {
        isEnabled: true,
      });
      expect(reEnabled.status).toBe(200);

      const afterEnable = await listMethods(patient);
      expect(afterEnable.status).toBe(200);
      const namesAfterEnable = (afterEnable.body as { name: string }[]).map(
        (m) => m.name,
      );
      expect(namesAfterEnable).toContain(name);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/payment-methods',
      );
      expect(response.status).toBe(401);
    });
  });

  describe('payment method creation (office/admin only)', () => {
    it('lets an office user create a method enabled by default with no description', async () => {
      const token = await roleToken(UserRole.OFFICE, 'office');
      const name = uniqueMethodName();

      const response = await createMethod(token, { name });

      expect(response.status).toBe(201);
      expect(response.body.name).toBe(name);
      expect(response.body.isEnabled).toBe(true);
      expect(response.body.description).toBeNull();
      const row = await methodRow(response.body.id as string);
      expect(row.name).toBe(name);
      expect(row.is_enabled).toBe(true);
      expect(row.description).toBeNull();
    });

    it('persists an explicit isEnabled false and a description', async () => {
      const token = await roleToken(UserRole.OFFICE, 'office');
      const name = uniqueMethodName();

      const response = await createMethod(token, {
        name,
        isEnabled: false,
        description: 'Pago diferido',
      });

      expect(response.status).toBe(201);
      expect(response.body.isEnabled).toBe(false);
      expect(response.body.description).toBe('Pago diferido');
      const row = await methodRow(response.body.id as string);
      expect(row.is_enabled).toBe(false);
      expect(row.description).toBe('Pago diferido');
    });

    it('lets an admin user create a method', async () => {
      const token = await roleToken(UserRole.ADMIN, 'admin');

      const response = await createMethod(token, { name: uniqueMethodName() });

      expect(response.status).toBe(201);
      expect(response.body.isEnabled).toBe(true);
    });

    it('rejects a duplicate name with 409 and persists nothing', async () => {
      const token = await roleToken(UserRole.OFFICE, 'office');
      const name = uniqueMethodName();
      const first = await createMethod(token, { name });
      expect(first.status).toBe(201);

      const response = await createMethod(token, { name });

      expect(response.status).toBe(409);
      const rows: IdRow[] = await dataSource.query(
        'SELECT id FROM payment_methods WHERE name = $1',
        [name],
      );
      expect(rows).toHaveLength(1);
    });

    it('rejects a name longer than 50 characters with 400', async () => {
      const token = await roleToken(UserRole.OFFICE, 'office');

      const response = await createMethod(token, { name: 'x'.repeat(51) });

      expect(response.status).toBe(400);
    });

    it('rejects a missing name with 400', async () => {
      const token = await roleToken(UserRole.OFFICE, 'office');

      const response = await createMethod(token, {});

      expect(response.status).toBe(400);
    });

    it('forbids patient-role users from creating methods (403)', async () => {
      const token = await roleToken(UserRole.PATIENT, 'patient');

      const response = await createMethod(token, { name: uniqueMethodName() });

      expect(response.status).toBe(403);
    });

    it('forbids doctor-role users from creating methods (403)', async () => {
      const token = await roleToken(UserRole.DOCTOR, 'doctor');

      const response = await createMethod(token, { name: uniqueMethodName() });

      expect(response.status).toBe(403);
    });
  });

  describe('payment method updates (office/admin only)', () => {
    it('lets an office user update name and description', async () => {
      const token = await roleToken(UserRole.OFFICE, 'office');
      const created = await createMethod(token, {
        name: uniqueMethodName(),
        description: 'Original description',
      });
      expect(created.status).toBe(201);

      const response = await updateMethod(token, created.body.id as string, {
        name: uniqueMethodName(),
        description: 'Updated description',
      });

      expect(response.status).toBe(200);
      expect(response.body.description).toBe('Updated description');
      const row = await methodRow(created.body.id as string);
      expect(row.description).toBe('Updated description');
      expect(row.name).toBe(response.body.name);
    });

    it('rejects a name update collision with 409 and persists nothing', async () => {
      const token = await roleToken(UserRole.OFFICE, 'office');
      const first = await createMethod(token, { name: uniqueMethodName() });
      expect(first.status).toBe(201);
      const second = await createMethod(token, { name: uniqueMethodName() });
      expect(second.status).toBe(201);

      const response = await updateMethod(token, second.body.id as string, {
        name: first.body.name as string,
      });

      expect(response.status).toBe(409);
      const row = await methodRow(second.body.id as string);
      expect(row.name).toBe(second.body.name);
    });

    it('returns 404 when the method does not exist', async () => {
      const token = await roleToken(UserRole.OFFICE, 'office');

      const response = await updateMethod(
        token,
        '00000000-0000-4000-8000-000000000000',
        { description: 'Nope' },
      );

      expect(response.status).toBe(404);
    });

    it('forbids patient-role users from updating methods (403)', async () => {
      const office = await roleToken(UserRole.OFFICE, 'office');
      const created = await createMethod(office, { name: uniqueMethodName() });
      expect(created.status).toBe(201);
      const patient = await roleToken(UserRole.PATIENT, 'patient');

      const response = await updateMethod(patient, created.body.id as string, {
        isEnabled: false,
      });

      expect(response.status).toBe(403);
      const row = await methodRow(created.body.id as string);
      expect(row.is_enabled).toBe(true);
    });

    it('rejects a duplicate name at the database level (unique constraint)', async () => {
      const name = uniqueMethodName();
      await expect(
        dataSource.query(
          'INSERT INTO payment_methods (name, is_enabled) VALUES ($1, true)',
          [name],
        ),
      ).resolves.toBeDefined();
      await expect(
        dataSource.query(
          'INSERT INTO payment_methods (name, is_enabled) VALUES ($1, true)',
          [name],
        ),
      ).rejects.toThrow();
    });
  });
});
