import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

// The spec shares db_creditos_test with other integration suites that run in
// parallel (npm test), so it never truncates. Every catalog name carries a
// per-run suffix (pid + timestamp), matching the unique-data convention of
// auth.spec.ts, patients.spec.ts and doctors.spec.ts.
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

function uniqueName(): string {
  return `Appendectomy-${RUN_SUFFIX}-${uniqueCounter++}`;
}

function emailFor(localPart: string): string {
  return `${localPart}.${RUN_SUFFIX}@example.com`;
}

interface IdRow {
  id: string;
}

describe('surgery catalog API (design section 5.5)', () => {
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

  async function officeToken(): Promise<string> {
    const officeId = await insertUserRaw(
      emailFor(`office.catalog.${uniqueCounter++}`),
      'Office Catalog',
      UserRole.OFFICE,
    );
    return tokenForUserId(officeId);
  }

  async function adminToken(): Promise<string> {
    const adminId = await insertUserRaw(
      emailFor(`admin.catalog.${uniqueCounter++}`),
      'Admin Catalog',
      UserRole.ADMIN,
    );
    return tokenForUserId(adminId);
  }

  async function patientToken(): Promise<string> {
    const patientUserId = await insertUserRaw(
      emailFor(`patient.catalog.${uniqueCounter++}`),
      'Patient Catalog',
      UserRole.PATIENT,
    );
    return tokenForUserId(patientUserId);
  }

  async function doctorToken(): Promise<string> {
    const doctorUserId = await insertUserRaw(
      emailFor(`doctor.catalog.${uniqueCounter++}`),
      'Doctor Catalog',
      UserRole.DOCTOR,
    );
    return tokenForUserId(doctorUserId);
  }

  function entryBody(overrides: Record<string, unknown> = {}) {
    return {
      name: uniqueName(),
      baseCost: '8000.00',
      ...overrides,
    };
  }

  function createEntry(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/surgery-catalog')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function getEntry(token: string, id: string) {
    return request(app.getHttpServer())
      .get(`/api/surgery-catalog/${id}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function listEntries(token: string, query: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .get('/api/surgery-catalog')
      .set('Authorization', `Bearer ${token}`)
      .query(query);
  }

  function updateEntry(
    token: string,
    id: string,
    body: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .patch(`/api/surgery-catalog/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  describe('catalog entry creation (office/admin only)', () => {
    it('lets an office user create a catalog entry persisted with a string baseCost', async () => {
      const token = await officeToken();

      const response = await createEntry(token, entryBody());

      expect(response.status).toBe(201);
      expect(response.body.name).toContain(`Appendectomy-${RUN_SUFFIX}`);
      expect(response.body.baseCost).toBe('8000.00');
      expect(typeof response.body.baseCost).toBe('string');

      const rows: {
        name: string;
        description: string | null;
        base_cost: string;
      }[] = await dataSource.query(
        'SELECT name, description, base_cost::text AS base_cost FROM surgery_catalog WHERE id = $1',
        [response.body.id as string],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe(response.body.name);
      expect(rows[0].description).toBeNull();
      expect(rows[0].base_cost).toBe('8000.00');
    });

    it('persists an optional description', async () => {
      const token = await officeToken();

      const response = await createEntry(
        token,
        entryBody({ description: 'Standard appendectomy' }),
      );

      expect(response.status).toBe(201);
      expect(response.body.description).toBe('Standard appendectomy');
      const rows: { description: string | null }[] = await dataSource.query(
        'SELECT description FROM surgery_catalog WHERE id = $1',
        [response.body.id as string],
      );
      expect(rows[0].description).toBe('Standard appendectomy');
    });

    it('lets an admin user create a catalog entry', async () => {
      const token = await adminToken();

      const response = await createEntry(token, entryBody());

      expect(response.status).toBe(201);
      expect(response.body.baseCost).toBe('8000.00');
    });

    it('rejects a duplicate name with 409 and persists nothing', async () => {
      const token = await officeToken();
      const body = entryBody();
      const first = await createEntry(token, body);
      expect(first.status).toBe(201);

      const response = await createEntry(token, entryBody({ name: body.name }));

      expect(response.status).toBe(409);
      const rows: IdRow[] = await dataSource.query(
        'SELECT id FROM surgery_catalog WHERE name = $1',
        [body.name as string],
      );
      expect(rows).toHaveLength(1);
    });

    it('rejects a negative base cost with 400 (DTO IsMoney)', async () => {
      const token = await officeToken();

      const response = await createEntry(
        token,
        entryBody({ baseCost: '-1.00' }),
      );

      expect(response.status).toBe(400);
    });

    it('rejects malformed money values with 400', async () => {
      const token = await officeToken();

      const threeDecimals = await createEntry(
        token,
        entryBody({ baseCost: '1.234' }),
      );
      expect(threeDecimals.status).toBe(400);

      const nonNumeric = await createEntry(
        token,
        entryBody({ baseCost: 'abc' }),
      );
      expect(nonNumeric.status).toBe(400);

      const numericType = await createEntry(
        token,
        entryBody({ baseCost: 8000 }),
      );
      expect(numericType.status).toBe(400);
    });

    it('rejects negative base_cost at the database level (CHECK constraint)', async () => {
      await expect(
        dataSource.query(
          'INSERT INTO surgery_catalog (name, base_cost) VALUES ($1, -1.00)',
          [`Negative-${RUN_SUFFIX}-${uniqueCounter++}`],
        ),
      ).rejects.toThrow();
    });

    it('forbids patient-role users from creating catalog entries (403)', async () => {
      const token = await patientToken();

      const response = await createEntry(token, entryBody());

      expect(response.status).toBe(403);
    });

    it('forbids doctor-role users from creating catalog entries (403)', async () => {
      const token = await doctorToken();

      const response = await createEntry(token, entryBody());

      expect(response.status).toBe(403);
    });
  });

  describe('catalog reads (any authenticated role)', () => {
    it('lets a patient read a catalog entry created by an office user', async () => {
      const office = await officeToken();
      const created = await createEntry(office, entryBody());
      expect(created.status).toBe(201);
      const patient = await patientToken();

      const response = await getEntry(patient, created.body.id as string);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.id);
      expect(response.body.name).toBe(created.body.name);
      expect(response.body.baseCost).toBe('8000.00');
    });

    it('lets patient and doctor roles list the catalog', async () => {
      const office = await officeToken();
      for (let i = 0; i < 3; i++) {
        const response = await createEntry(office, entryBody());
        expect(response.status).toBe(201);
      }
      const patient = await patientToken();
      const doctor = await doctorToken();

      const patientList = await listEntries(patient);
      const doctorList = await listEntries(doctor);

      expect(patientList.status).toBe(200);
      expect(patientList.body.data.length).toBeGreaterThanOrEqual(3);
      expect(doctorList.status).toBe(200);
      expect(doctorList.body.data.length).toBeGreaterThanOrEqual(3);
    });

    it('returns 404 for an unknown catalog entry', async () => {
      const token = await officeToken();

      const response = await getEntry(
        token,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(response.status).toBe(404);
    });

    it('lists catalog entries paginated for office users (10 of 25 via shared PaginationDto)', async () => {
      const token = await officeToken();
      for (let i = 0; i < 25; i++) {
        const response = await createEntry(token, entryBody());
        expect(response.status).toBe(201);
      }

      const response = await listEntries(token, { limit: 10, offset: 0 });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(10);
      // total counts every catalog row in the shared database (other runs may
      // leave rows behind), so it must be at least our 25 and match the real
      // table count the pagination query reports.
      expect(response.body.total).toBeGreaterThanOrEqual(25);
      const dbCount: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM surgery_catalog',
      );
      expect(response.body.total).toBe(Number(dbCount[0].count));
      expect(response.body.limit).toBe(10);
      expect(response.body.offset).toBe(0);
    });
  });

  describe('catalog updates (office/admin only)', () => {
    it('lets an office user update description and baseCost', async () => {
      const token = await officeToken();
      const created = await createEntry(token, entryBody());
      expect(created.status).toBe(201);

      const response = await updateEntry(token, created.body.id as string, {
        description: 'Updated description',
        baseCost: '9500.50',
      });

      expect(response.status).toBe(200);
      expect(response.body.description).toBe('Updated description');
      expect(response.body.baseCost).toBe('9500.50');
      const rows: { base_cost: string; description: string | null }[] =
        await dataSource.query(
          'SELECT base_cost::text AS base_cost, description FROM surgery_catalog WHERE id = $1',
          [created.body.id as string],
        );
      expect(rows[0].base_cost).toBe('9500.50');
      expect(rows[0].description).toBe('Updated description');
    });

    it('rejects a name update collision with 409 and persists nothing', async () => {
      const token = await officeToken();
      const first = await createEntry(token, entryBody());
      const second = await createEntry(token, entryBody());

      const response = await updateEntry(token, second.body.id as string, {
        name: first.body.name as string,
      });

      expect(response.status).toBe(409);
      const rows: { name: string }[] = await dataSource.query(
        'SELECT name FROM surgery_catalog WHERE id = $1',
        [second.body.id as string],
      );
      expect(rows[0].name).toBe(second.body.name);
    });

    it('forbids patient-role users from updating catalog entries (403)', async () => {
      const office = await officeToken();
      const created = await createEntry(office, entryBody());
      const patient = await patientToken();

      const response = await updateEntry(patient, created.body.id as string, {
        description: 'Hacked',
      });

      expect(response.status).toBe(403);
    });
  });

  describe('authentication', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/surgery-catalog',
      );
      expect(response.status).toBe(401);
    });
  });
});
