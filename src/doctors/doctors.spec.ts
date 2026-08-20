import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

// The spec shares db_creditos_test with other integration suites that run in
// parallel (npm test), so it never truncates: fixed values would collide with
// leftovers from a previous run, and a mid-flight TRUNCATE would wipe another
// suite's rows. Every email and professional license carries a per-run suffix
// (pid + timestamp), matching the unique-data convention of auth.spec.ts and
// patients.spec.ts.
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

function uniqueLicense(): string {
  return `MED-${RUN_SUFFIX}-${uniqueCounter++}`;
}

function emailFor(localPart: string): string {
  return `${localPart}.${RUN_SUFFIX}@example.com`;
}

interface IdRow {
  id: string;
}

describe('doctors API (mandatory web account, design sections 5.4 and 8.1-T8)', () => {
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
      emailFor(`office.doctors.${uniqueCounter++}`),
      'Office Doctors',
      UserRole.OFFICE,
    );
    return tokenForUserId(officeId);
  }

  async function adminToken(): Promise<string> {
    const adminId = await insertUserRaw(
      emailFor(`admin.doctors.${uniqueCounter++}`),
      'Admin Doctors',
      UserRole.ADMIN,
    );
    return tokenForUserId(adminId);
  }

  async function patientUserToken(localPart: string): Promise<string> {
    const patientUserId = await insertUserRaw(
      emailFor(localPart),
      'Patient User',
      UserRole.PATIENT,
    );
    return tokenForUserId(patientUserId);
  }

  function doctorBody(overrides: Record<string, unknown> = {}) {
    return {
      email: emailFor(`doctor.${uniqueCounter++}`),
      password: 'Abc123',
      name: 'Juan Perez',
      firstName: 'Juan',
      paternalLastName: 'Perez',
      maternalLastName: 'Mamani',
      phone: `+59171${RUN_SUFFIX}${uniqueCounter++}`,
      specialty: 'Cardiology',
      professionalLicense: uniqueLicense(),
      ...overrides,
    };
  }

  function createDoctor(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/doctors')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function getDoctor(token: string, id: string) {
    return request(app.getHttpServer())
      .get(`/api/doctors/${id}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function updateDoctor(
    token: string,
    id: string,
    body: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .patch(`/api/doctors/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function listDoctors(token: string, query: Record<string, unknown>) {
    return request(app.getHttpServer())
      .get('/api/doctors')
      .set('Authorization', `Bearer ${token}`)
      .query(query);
  }

  describe('doctor registration (T8 atomic user + doctor)', () => {
    it('lets an office user create a doctor: users row (role doctor, bcrypt) and doctors row in one transaction', async () => {
      const token = await officeToken();

      const response = await createDoctor(token, doctorBody());

      expect(response.status).toBe(201);
      expect(response.body.specialty).toBe('Cardiology');
      expect(response.body.professionalLicense).toContain(`MED-${RUN_SUFFIX}`);

      const userRows: (IdRow & { role: string; password: string })[] =
        await dataSource.query(
          'SELECT id, role, password FROM users WHERE id = $1',
          [response.body.userId as string],
        );
      expect(userRows).toHaveLength(1);
      expect(userRows[0].role).toBe(UserRole.DOCTOR);
      // The password is bcrypt-hashed, never stored in plain text.
      expect(userRows[0].password).not.toBe('Abc123');
      expect(bcrypt.compareSync('Abc123', userRows[0].password)).toBe(true);

      const doctorRows: IdRow[] = await dataSource.query(
        'SELECT id FROM doctors WHERE user_id = $1',
        [response.body.userId as string],
      );
      expect(doctorRows).toHaveLength(1);
    });

    it('lets an admin user create a doctor with role doctor', async () => {
      const token = await adminToken();

      const response = await createDoctor(token, doctorBody());

      expect(response.status).toBe(201);
      const userRows: { role: string }[] = await dataSource.query(
        'SELECT role FROM users WHERE id = $1',
        [response.body.userId as string],
      );
      expect(userRows[0].role).toBe(UserRole.DOCTOR);
    });

    it('rejects a duplicate professional license with 409 and rolls back the users row (T8 atomicity)', async () => {
      const token = await officeToken();
      const first = await createDoctor(token, doctorBody());
      expect(first.status).toBe(201);

      const duplicateBody = doctorBody({
        professionalLicense: first.body.professionalLicense as string,
      });
      const response = await createDoctor(token, duplicateBody);

      expect(response.status).toBe(409);
      // The attempted account must not exist: the transaction rolled back both
      // the doctors row (unique license) and the users row created in the same
      // transaction.
      const doctorRows: IdRow[] = await dataSource.query(
        'SELECT id FROM doctors WHERE professional_license = $1',
        [first.body.professionalLicense as string],
      );
      expect(doctorRows).toHaveLength(1);
      const leftoverUsers: IdRow[] = await dataSource.query(
        'SELECT id FROM users WHERE email = $1',
        [duplicateBody.email as string],
      );
      expect(leftoverUsers).toHaveLength(0);
    });

    it('rejects patient-role users from creating doctors (403)', async () => {
      const token = await patientUserToken('patient.create.doctor');

      const response = await createDoctor(token, doctorBody());

      expect(response.status).toBe(403);
    });

    it('rejects a doctor creation without account fields when no userId is provided (400)', async () => {
      const token = await officeToken();

      const response = await createDoctor(token, {
        firstName: 'Juan',
        paternalLastName: 'Perez',
        phone: `+59171${RUN_SUFFIX}${uniqueCounter++}`,
        specialty: 'Cardiology',
        professionalLicense: uniqueLicense(),
      });

      expect(response.status).toBe(400);
    });
  });

  describe('doctor query and update (own-record rule)', () => {
    it('lists doctors paginated for office users (10 of 25 via shared PaginationDto)', async () => {
      const token = await officeToken();
      for (let i = 0; i < 25; i++) {
        const response = await createDoctor(token, doctorBody());
        expect(response.status).toBe(201);
      }

      const response = await listDoctors(token, { limit: 10, offset: 0 });

      expect(response.status).toBe(200);
      expect(response.body.data).toHaveLength(10);
      // total counts every doctor row in the shared database (other runs may
      // leave rows behind), so it must be at least our 25 and match the real
      // table count the pagination query reports.
      expect(response.body.total).toBeGreaterThanOrEqual(25);
      const dbCount: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM doctors',
      );
      expect(response.body.total).toBe(Number(dbCount[0].count));
      expect(response.body.limit).toBe(10);
      expect(response.body.offset).toBe(0);
    });

    it('lets an office user read any doctor', async () => {
      const token = await officeToken();
      const created = await createDoctor(token, doctorBody());
      expect(created.status).toBe(201);

      const response = await getDoctor(token, created.body.id as string);

      expect(response.status).toBe(200);
      expect(response.body.specialty).toBe('Cardiology');
      expect(response.body.professionalLicense).toBe(
        created.body.professionalLicense,
      );
    });

    it('returns 404 for an unknown doctor', async () => {
      const token = await officeToken();

      const response = await getDoctor(
        token,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(response.status).toBe(404);
    });

    it('lets a doctor-role user read their own record', async () => {
      const office = await officeToken();
      const created = await createDoctor(office, doctorBody());
      const doctorToken = await tokenForUserId(created.body.userId as string);

      const response = await getDoctor(doctorToken, created.body.id as string);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.id);
      expect(response.body.userId).toBe(created.body.userId);
      expect(response.body.specialty).toBe('Cardiology');
      expect(response.body.professionalLicense).toBe(
        created.body.professionalLicense,
      );
    });

    it('forbids a doctor-role user from reading another doctor record (403)', async () => {
      const office = await officeToken();
      const own = await createDoctor(office, doctorBody());
      const other = await createDoctor(office, doctorBody());
      const doctorToken = await tokenForUserId(own.body.userId as string);

      const response = await getDoctor(doctorToken, other.body.id as string);

      expect(response.status).toBe(403);
    });

    it('forbids patient-role users from reading doctor records (403)', async () => {
      const office = await officeToken();
      const created = await createDoctor(office, doctorBody());
      const patientToken = await patientUserToken('patient.read.doctor');

      const readOne = await getDoctor(patientToken, created.body.id as string);
      expect(readOne.status).toBe(403);

      const readAll = await listDoctors(patientToken, {});
      expect(readAll.status).toBe(403);
    });

    it('lets an office user update a doctor specialty', async () => {
      const token = await officeToken();
      const created = await createDoctor(token, doctorBody());

      const response = await updateDoctor(token, created.body.id as string, {
        specialty: 'Neurology',
      });

      expect(response.status).toBe(200);
      expect(response.body.specialty).toBe('Neurology');
      const doctorRows: { specialty: string }[] = await dataSource.query(
        'SELECT specialty FROM doctors WHERE id = $1',
        [created.body.id as string],
      );
      expect(doctorRows[0].specialty).toBe('Neurology');
    });

    it('rejects a professional license update collision with 409 and persists nothing', async () => {
      const token = await officeToken();
      const first = await createDoctor(token, doctorBody());
      const second = await createDoctor(token, doctorBody());

      const response = await updateDoctor(token, second.body.id as string, {
        professionalLicense: first.body.professionalLicense as string,
      });

      expect(response.status).toBe(409);
      const doctorRows: { professional_license: string }[] =
        await dataSource.query(
          'SELECT professional_license FROM doctors WHERE id = $1',
          [second.body.id as string],
        );
      expect(doctorRows[0].professional_license).toBe(
        second.body.professionalLicense,
      );
    });

    it('forbids doctor-role users from updating doctor records (403)', async () => {
      const office = await officeToken();
      const created = await createDoctor(office, doctorBody());
      const doctorToken = await tokenForUserId(created.body.userId as string);

      const response = await updateDoctor(
        doctorToken,
        created.body.id as string,
        {
          specialty: 'Neurology',
        },
      );

      expect(response.status).toBe(403);
    });
  });

  describe('link to an existing user account', () => {
    it('creates the doctor row linked to a provided userId and upgrades that user to role doctor', async () => {
      const office = await officeToken();
      const existingUserId = await insertUserRaw(
        emailFor('existing.doctor.account'),
        'Existing Account',
        UserRole.PATIENT,
      );

      const response = await createDoctor(office, {
        userId: existingUserId,
        specialty: 'Pediatrics',
        professionalLicense: uniqueLicense(),
        firstName: 'Juan',
        paternalLastName: 'Perez',
        phone: `+59171${RUN_SUFFIX}${uniqueCounter++}`,
      });

      expect(response.status).toBe(201);
      expect(response.body.userId).toBe(existingUserId);
      const userRows: { role: string }[] = await dataSource.query(
        'SELECT role FROM users WHERE id = $1',
        [existingUserId],
      );
      expect(userRows[0].role).toBe(UserRole.DOCTOR);
      const doctorRows: IdRow[] = await dataSource.query(
        'SELECT id FROM doctors WHERE user_id = $1',
        [existingUserId],
      );
      expect(doctorRows).toHaveLength(1);
    });

    it('returns 404 when the provided userId does not exist', async () => {
      const office = await officeToken();

      const response = await createDoctor(office, {
        userId: '00000000-0000-4000-8000-000000000000',
        specialty: 'Pediatrics',
        professionalLicense: uniqueLicense(),
        firstName: 'Juan',
        paternalLastName: 'Perez',
        phone: `+59171${RUN_SUFFIX}${uniqueCounter++}`,
      });

      expect(response.status).toBe(404);
    });
  });

  describe('doctor profile fields (design doctor-details-and-lists, AD4-AD6)', () => {
    it('rejects creation missing any of firstName, paternalLastName or phone (400, account path)', async () => {
      const token = await officeToken();

      for (const missing of [
        'firstName',
        'paternalLastName',
        'phone',
      ] as const) {
        const body = doctorBody() as Record<string, unknown>;
        delete body[missing];
        const response = await createDoctor(token, body);
        expect(response.status).toBe(400);
      }
    });

    it('rejects creation missing any of firstName, paternalLastName or phone (400, userId path)', async () => {
      const office = await officeToken();
      const existingUserId = await insertUserRaw(
        emailFor('existing.profile.doctor'),
        'Existing Profile',
        UserRole.PATIENT,
      );

      for (const missing of [
        'firstName',
        'paternalLastName',
        'phone',
      ] as const) {
        const body: Record<string, unknown> = {
          userId: existingUserId,
          specialty: 'Pediatrics',
          professionalLicense: uniqueLicense(),
          firstName: 'Juan',
          paternalLastName: 'Perez',
          phone: `+59171${RUN_SUFFIX}${uniqueCounter++}`,
        };
        delete body[missing];
        const response = await createDoctor(office, body);
        expect(response.status).toBe(400);
      }
    });

    it('normalizes the phone on create and PATCH (+591 71 <digits> -> +59171<digits>)', async () => {
      const token = await officeToken();
      const createCounter = uniqueCounter++;

      const created = await createDoctor(token, {
        ...doctorBody(),
        phone: `+591 71 ${RUN_SUFFIX}${createCounter}`,
      });
      expect(created.status).toBe(201);
      expect(created.body.phone).toBe(`+59171${RUN_SUFFIX}${createCounter}`);

      const patchCounter = uniqueCounter++;
      const patched = await updateDoctor(token, created.body.id as string, {
        phone: `+591 71 ${RUN_SUFFIX}${patchCounter}`,
      });
      expect(patched.status).toBe(200);
      expect(patched.body.phone).toBe(`+59171${RUN_SUFFIX}${patchCounter}`);
    });

    it('rejects a duplicate normalized phone on create with 409 and rolls back the users row (T8 atomicity)', async () => {
      const token = await officeToken();
      const phoneCounter = uniqueCounter++;

      const first = await createDoctor(token, {
        ...doctorBody(),
        phone: `+591 71 ${RUN_SUFFIX}${phoneCounter}`,
      });
      expect(first.status).toBe(201);

      const duplicateBody = doctorBody({
        phone: `+59171${RUN_SUFFIX}${phoneCounter}`,
      });
      const response = await createDoctor(token, duplicateBody);

      expect(response.status).toBe(409);
      const doctorRows: IdRow[] = await dataSource.query(
        'SELECT id FROM doctors WHERE phone = $1',
        [`+59171${RUN_SUFFIX}${phoneCounter}`],
      );
      expect(doctorRows).toHaveLength(1);
      const leftoverUsers: IdRow[] = await dataSource.query(
        'SELECT id FROM users WHERE email = $1',
        [duplicateBody.email as string],
      );
      expect(leftoverUsers).toHaveLength(0);
    });

    it('rejects a phone update collision with 409 and persists nothing', async () => {
      const token = await officeToken();
      const first = await createDoctor(token, doctorBody());
      const second = await createDoctor(token, doctorBody());

      const response = await updateDoctor(token, second.body.id as string, {
        phone: first.body.phone as string,
      });

      expect(response.status).toBe(409);
      const doctorRows: { phone: string }[] = await dataSource.query(
        'SELECT phone FROM doctors WHERE id = $1',
        [second.body.id as string],
      );
      expect(doctorRows[0].phone).toBe(second.body.phone);
    });

    it('returns nested user without a password key on read and list (AD6)', async () => {
      const token = await officeToken();
      const created = await createDoctor(token, doctorBody());
      expect(created.status).toBe(201);

      const read = await getDoctor(token, created.body.id as string);
      expect(read.status).toBe(200);
      expect(read.body.user).toBeDefined();
      expect(read.body.user.id).toBe(created.body.userId);
      expect(read.body.user.name).toBe('Juan Perez');
      expect('password' in read.body.user).toBe(false);

      const list = await listDoctors(token, { limit: 10, offset: 0 });
      expect(list.status).toBe(200);
      expect(list.body.data.length).toBeGreaterThan(0);
      for (const row of list.body.data as Array<Record<string, unknown>>) {
        expect(row.user).toBeDefined();
        expect('password' in (row.user as Record<string, unknown>)).toBe(false);
      }
    });

    it('never syncs profile fields into users.name (create and PATCH)', async () => {
      const token = await officeToken();
      const created = await createDoctor(token, doctorBody());
      expect(created.status).toBe(201);

      const nameAfterCreate: { name: string }[] = await dataSource.query(
        'SELECT name FROM users WHERE id = $1',
        [created.body.userId as string],
      );
      expect(nameAfterCreate[0].name).toBe('Juan Perez');

      const patched = await updateDoctor(token, created.body.id as string, {
        firstName: 'Changed',
        paternalLastName: 'Surname',
      });
      expect(patched.status).toBe(200);

      const nameAfterPatch: { name: string }[] = await dataSource.query(
        'SELECT name FROM users WHERE id = $1',
        [created.body.userId as string],
      );
      expect(nameAfterPatch[0].name).toBe('Juan Perez');
    });
  });

  describe('authentication', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const response = await request(app.getHttpServer()).get('/api/doctors');
      expect(response.status).toBe(401);
    });
  });
});
