import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

// The spec shares db_creditos_test with other integration suites that run in
// parallel (npm test), so it never truncates: fixed values would collide with
// leftovers from a previous run, and a mid-flight TRUNCATE would wipe another
// suite's rows. Every phone/identity document/email carries a per-run suffix
// (pid + timestamp), matching the unique-data convention of auth.spec.ts.
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
// identity_document is varchar(20): pid (5) + last 10 timestamp digits + up to
// 3 counter digits stays within the limit while remaining unique per run.
const ID_DOCUMENT_SUFFIX = `${process.pid}${String(Date.now()).slice(-10)}`;
let uniqueCounter = 0;

function uniquePhone(): string {
  return `+5917${RUN_SUFFIX}${uniqueCounter++}`;
}

function uniqueIdentityDocument(): string {
  return `${ID_DOCUMENT_SUFFIX}${uniqueCounter++}`;
}

function emailFor(localPart: string): string {
  return `${localPart}.${RUN_SUFFIX}@example.com`;
}

interface IdRow {
  id: string;
}

describe('patients API (hybrid account model, design sections 5.3 and 8.1-T9)', () => {
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
      emailFor(`office.patients.${uniqueCounter++}`),
      'Office Patients',
      UserRole.OFFICE,
    );
    return tokenForUserId(officeId);
  }

  async function patientUserToken(localPart: string): Promise<string> {
    const patientUserId = await insertUserRaw(
      emailFor(localPart),
      'Patient User',
      UserRole.PATIENT,
    );
    return tokenForUserId(patientUserId);
  }

  function createPatient(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/patients')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function getPatient(token: string, id: string) {
    return request(app.getHttpServer())
      .get(`/api/patients/${id}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function updatePatient(token: string, id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/patients/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function linkUser(token: string, id: string, userId: string) {
    return request(app.getHttpServer())
      .post(`/api/patients/${id}/link-user`)
      .set('Authorization', `Bearer ${token}`)
      .send({ userId });
  }

  function listPatients(token: string, query: Record<string, unknown>) {
    return request(app.getHttpServer())
      .get('/api/patients')
      .set('Authorization', `Bearer ${token}`)
      .query(query);
  }

  function patientBody(overrides: Record<string, unknown> = {}) {
    return {
      identityDocument: uniqueIdentityDocument(),
      firstName: 'Juan',
      paternalLastName: 'Perez',
      phone: uniquePhone(),
      ...overrides,
    };
  }

  describe('patient registration (hybrid account model)', () => {
    it('lets an office user register a patient without credentials (user_id NULL, no users row)', async () => {
      const token = await officeToken();
      const usersBefore: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM users WHERE email LIKE $1',
        [`%.${RUN_SUFFIX}@example.com`],
      );

      const response = await createPatient(token, patientBody());

      expect(response.status).toBe(201);
      expect(response.body.firstName).toBe('Juan');
      expect(response.body.paternalLastName).toBe('Perez');
      expect(response.body.userId).toBeNull();

      const rows: (IdRow & { userId: string | null })[] = await dataSource.query(
        'SELECT id, user_id AS "userId" FROM patients WHERE phone = $1',
        [response.body.phone as string],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBeNull();

      // Scoped to this run's users: parallel suites insert their own rows into
      // the shared table, so a global COUNT is racy; our suffix is exclusive.
      const usersAfter: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM users WHERE email LIKE $1',
        [`%.${RUN_SUFFIX}@example.com`],
      );
      expect(usersAfter[0].count).toBe(usersBefore[0].count);
    });

    it('rejects a duplicate phone with 409 and persists nothing', async () => {
      const token = await officeToken();
      const first = await createPatient(token, patientBody());
      expect(first.status).toBe(201);

      const response = await createPatient(
        token,
        patientBody({ phone: first.body.phone as string }),
      );

      expect(response.status).toBe(409);
      const rows: IdRow[] = await dataSource.query(
        'SELECT id FROM patients WHERE phone = $1',
        [first.body.phone as string],
      );
      expect(rows).toHaveLength(1);
    });

    it('rejects a duplicate identity document with 409', async () => {
      const token = await officeToken();
      const first = await createPatient(token, patientBody());

      const response = await createPatient(
        token,
        patientBody({ identityDocument: first.body.identityDocument as string }),
      );

      expect(response.status).toBe(409);
    });

    it('rejects patient-role users from creating patients (403)', async () => {
      const token = await patientUserToken('patient.create');

      const response = await createPatient(token, patientBody());

      expect(response.status).toBe(403);
    });
  });

  describe('patient query and update (own-record rule)', () => {
    it('lets an office user read any patient', async () => {
      const token = await officeToken();
      const created = await createPatient(token, patientBody());
      expect(created.status).toBe(201);

      const response = await getPatient(token, created.body.id as string);

      expect(response.status).toBe(200);
      expect(response.body.identityDocument).toBe(
        created.body.identityDocument,
      );
      expect(response.body.paternalLastName).toBe('Perez');
    });

    it('returns 404 for an unknown patient', async () => {
      const token = await officeToken();

      const response = await getPatient(
        token,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(response.status).toBe(404);
    });

    it('lets a linked patient-role user read their own record', async () => {
      const office = await officeToken();
      const created = await createPatient(office, patientBody());
      const patientUserId = await insertUserRaw(
        emailFor('patient.own'),
        'Patient Own',
        UserRole.PATIENT,
      );
      await linkUser(office, created.body.id as string, patientUserId);
      const patientToken = await tokenForUserId(patientUserId);

      const response = await getPatient(patientToken, created.body.id as string);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.id);
      expect(response.body.userId).toBe(patientUserId);
    });

    it('forbids a patient-role user from reading another patient record (403)', async () => {
      const office = await officeToken();
      const own = await createPatient(office, patientBody());
      const other = await createPatient(office, patientBody());
      const patientUserId = await insertUserRaw(
        emailFor('patient.other'),
        'Patient Other',
        UserRole.PATIENT,
      );
      await linkUser(office, own.body.id as string, patientUserId);
      const patientToken = await tokenForUserId(patientUserId);

      const response = await getPatient(patientToken, other.body.id as string);

      expect(response.status).toBe(403);
    });

    it('lists patients paginated for office users (10 of 25 via shared PaginationDto)', async () => {
      const token = await officeToken();
      for (let i = 0; i < 25; i++) {
        const response = await createPatient(token, patientBody());
        expect(response.status).toBe(201);
      }

      const response = await listPatients(token, { limit: 10, offset: 0 });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(10);
      // total counts every patient row in the shared database (other runs may
      // leave rows behind), so it must be at least our 25 and match the real
      // table count the pagination query reports.
      expect(response.body.total).toBeGreaterThanOrEqual(25);
      const dbCount: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM patients',
      );
      expect(response.body.total).toBe(Number(dbCount[0].count));
      expect(response.body.limit).toBe(10);
      expect(response.body.offset).toBe(0);
    });

    it('lets a patient-role user update only their own record', async () => {
      const office = await officeToken();
      const own = await createPatient(office, patientBody());
      const patientUserId = await insertUserRaw(
        emailFor('patient.update'),
        'Patient Update',
        UserRole.PATIENT,
      );
      await linkUser(office, own.body.id as string, patientUserId);
      const patientToken = await tokenForUserId(patientUserId);

      const ownUpdate = await updatePatient(patientToken, own.body.id as string, {
        address: 'Av. Siempre Viva 123',
      });
      expect(ownUpdate.status).toBe(200);
      expect(ownUpdate.body.address).toBe('Av. Siempre Viva 123');

      const other = await createPatient(office, patientBody());
      const otherUpdate = await updatePatient(
        patientToken,
        other.body.id as string,
        { address: 'Calle Otra 9' },
      );
      expect(otherUpdate.status).toBe(403);
    });

    it('re-validates uniqueness on update (duplicate phone → 409)', async () => {
      const token = await officeToken();
      const first = await createPatient(token, patientBody());
      const second = await createPatient(token, patientBody());

      const response = await updatePatient(
        token,
        second.body.id as string,
        { phone: first.body.phone as string },
      );

      expect(response.status).toBe(409);
      const rows: IdRow[] = await dataSource.query(
        'SELECT id FROM patients WHERE phone = $1',
        [second.body.phone as string],
      );
      expect(rows).toHaveLength(1);
    });
  });

  describe('link user to patient (T9 transactional flow)', () => {
    it('links a patient-role user to a patient with user_id NULL', async () => {
      const office = await officeToken();
      const created = await createPatient(office, patientBody());
      const patientUserId = await insertUserRaw(
        emailFor('patient.link'),
        'Patient Link',
        UserRole.PATIENT,
      );

      const response = await linkUser(
        office,
        created.body.id as string,
        patientUserId,
      );

      expect(response.status).toBe(201);
      expect(response.body.userId).toBe(patientUserId);
      const rows: { userId: string | null }[] = await dataSource.query(
        'SELECT user_id AS "userId" FROM patients WHERE id = $1',
        [created.body.id as string],
      );
      expect(rows[0].userId).toBe(patientUserId);
    });

    it('rejects linking an already-linked patient with 409', async () => {
      const office = await officeToken();
      const created = await createPatient(office, patientBody());
      const firstUser = await insertUserRaw(
        emailFor('patient.link.one'),
        'Patient Link One',
        UserRole.PATIENT,
      );
      const secondUser = await insertUserRaw(
        emailFor('patient.link.two'),
        'Patient Link Two',
        UserRole.PATIENT,
      );
      await linkUser(office, created.body.id as string, firstUser);

      const response = await linkUser(
        office,
        created.body.id as string,
        secondUser,
      );

      expect(response.status).toBe(409);
      const rows: { userId: string | null }[] = await dataSource.query(
        'SELECT user_id AS "userId" FROM patients WHERE id = $1',
        [created.body.id as string],
      );
      expect(rows[0].userId).toBe(firstUser);
    });

    it('rejects a user already linked to another patient with 409 and persists nothing', async () => {
      const office = await officeToken();
      const firstPatient = await createPatient(office, patientBody());
      const secondPatient = await createPatient(office, patientBody());
      const sharedUser = await insertUserRaw(
        emailFor('patient.shared'),
        'Patient Shared',
        UserRole.PATIENT,
      );
      await linkUser(office, firstPatient.body.id as string, sharedUser);

      const response = await linkUser(
        office,
        secondPatient.body.id as string,
        sharedUser,
      );

      expect(response.status).toBe(409);
      const rows: { userId: string | null }[] = await dataSource.query(
        'SELECT user_id AS "userId" FROM patients WHERE id = $1',
        [secondPatient.body.id as string],
      );
      expect(rows[0].userId).toBeNull();
    });

    it('returns 404 when the patient or the user does not exist', async () => {
      const office = await officeToken();
      const created = await createPatient(office, patientBody());
      expect(created.status).toBe(201);

      const missingPatient = await linkUser(
        office,
        '00000000-0000-4000-8000-000000000000',
        '00000000-0000-4000-8000-000000000001',
      );
      expect(missingPatient.status).toBe(404);

      const missingUser = await linkUser(
        office,
        created.body.id as string,
        '00000000-0000-4000-8000-000000000002',
      );
      expect(missingUser.status).toBe(404);
    });
  });

  describe('authentication', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await request(app.getHttpServer()).get('/api/patients');
      expect(response.status).toBe(401);
    });
  });
});
