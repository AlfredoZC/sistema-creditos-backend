import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { SurgeryDoctorRole, SurgeryStatus, UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

// The spec shares db_creditos_test with other integration suites that run in
// parallel (npm test), so it never truncates: fixed values would collide with
// leftovers from a previous run, and a mid-flight TRUNCATE would wipe another
// suite's rows. Every email, license, identity document and phone carries a
// per-run suffix (pid + timestamp), matching the unique-data convention of
// the other integration specs.
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

describe('surgeries API (design sections 5.6, 5.7 and 8.1-T6/T7)', () => {
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

  async function officeUser(): Promise<{ id: string; token: string }> {
    const id = await insertUserRaw(
      emailFor(`office.surgeries.${uniqueCounter++}`),
      'Office Surgeries',
      UserRole.OFFICE,
    );
    return { id, token: await tokenForUserId(id) };
  }

  async function adminToken(): Promise<string> {
    const adminId = await insertUserRaw(
      emailFor(`admin.surgeries.${uniqueCounter++}`),
      'Admin Surgeries',
      UserRole.ADMIN,
    );
    return tokenForUserId(adminId);
  }

  async function patientToken(): Promise<string> {
    const patientUserId = await insertUserRaw(
      emailFor(`patient.surgeries.${uniqueCounter++}`),
      'Patient Surgeries',
      UserRole.PATIENT,
    );
    return tokenForUserId(patientUserId);
  }

  // identity_document is varchar(20): a base36 timestamp keeps the value short
  // and unique per run while staying under the column limit.
  function uniqueDocument(): string {
    return `DOC${Date.now().toString(36)}${uniqueCounter++}`;
  }

  async function createPatientRaw(): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [uniqueDocument(), 'Maria', 'Gomez', `+51${RUN_SUFFIX}${uniqueCounter++}`],
    );
    return rows[0].id;
  }

  async function createCatalogEntry(token: string): Promise<{
    id: string;
    baseCost: string;
  }> {
    const response = await request(app.getHttpServer())
      .post('/api/surgery-catalog')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: `Appendectomy-${RUN_SUFFIX}-${uniqueCounter++}`,
        baseCost: '8000.00',
      });
    expect(response.status).toBe(201);
    return { id: response.body.id as string, baseCost: response.body.baseCost as string };
  }

  async function createDoctorRaw(): Promise<string> {
    const userId = await insertUserRaw(
      emailFor(`doctor.surgeries.${uniqueCounter++}`),
      'Doctor Surgeries',
      UserRole.DOCTOR,
    );
    // AD10: uq_doctors_phone rejects two DEFAULT '' rows, so every raw insert
    // carries a per-call unique phone (doctor series +59171..., disjoint from
    // the patients' +59170... series).
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO doctors (user_id, specialty, professional_license, phone)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [userId, 'Cardiology', uniqueLicense(), `+59171${RUN_SUFFIX}${uniqueCounter++}`],
    );
    return rows[0].id;
  }

  function surgeryBody(
    patientId: string,
    catalogId: string,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      patientId,
      surgeryCatalogId: catalogId,
      scheduledDate: '2026-08-15',
      ...overrides,
    };
  }

  function createSurgery(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/surgeries')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function updateSurgery(token: string, id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/surgeries/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function updateSurgeryStatus(token: string, id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/api/surgeries/${id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function assignDoctor(token: string, id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/surgeries/${id}/doctors`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function reassignPrincipal(token: string, id: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/api/surgeries/${id}/doctors/reassign-principal`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function surgeryRow(id: string): Promise<{
    status: string;
    total_cost: string;
    scheduled_date: string;
    notes: string | null;
  }> {
    const rows: {
      status: string;
      total_cost: string;
      scheduled_date: string;
      notes: string | null;
    }[] = await dataSource.query(
      `SELECT status, total_cost::text AS total_cost,
              scheduled_date::text AS scheduled_date, notes
       FROM surgeries WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function auditRows(surgeryId: string): Promise<
    {
      user_id: string | null;
      action: string;
      table_name: string;
      record_id: string;
      previous_data: { status: string } | null;
      new_data: { status: string } | null;
    }[]
  > {
    return dataSource.query(
      `SELECT user_id, action, table_name, record_id, previous_data, new_data
       FROM audit_logs WHERE record_id = $1 AND action = 'surgery.status_changed'
       ORDER BY created_at`,
      [surgeryId],
    );
  }

  async function principalCount(surgeryId: string): Promise<number> {
    const rows: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*)::text AS count FROM surgery_doctors
       WHERE surgery_id = $1 AND role = 'principal'`,
      [surgeryId],
    );
    return Number(rows[0].count);
  }

  async function roleOf(surgeryId: string, doctorId: string): Promise<string | null> {
    const rows: { role: string }[] = await dataSource.query(
      `SELECT role FROM surgery_doctors WHERE surgery_id = $1 AND doctor_id = $2`,
      [surgeryId, doctorId],
    );
    return rows.length === 0 ? null : rows[0].role;
  }

  async function assignmentCount(surgeryId: string, doctorId: string): Promise<number> {
    const rows: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*)::text AS count FROM surgery_doctors
       WHERE surgery_id = $1 AND doctor_id = $2`,
      [surgeryId, doctorId],
    );
    return Number(rows[0].count);
  }

  describe('surgery scheduling (D2: totalCost defaults to catalog base cost)', () => {
    it('creates a surgery with status scheduled and the catalog base cost when totalCost is omitted', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);

      const response = await createSurgery(
        office.token,
        surgeryBody(patientId, catalog.id),
      );

      expect(response.status).toBe(201);
      expect(response.body.status).toBe(SurgeryStatus.SCHEDULED);
      expect(response.body.totalCost).toBe(catalog.baseCost);
      expect(response.body.notes).toBeNull();

      const row = await surgeryRow(response.body.id as string);
      expect(row.status).toBe(SurgeryStatus.SCHEDULED);
      expect(row.total_cost).toBe('8000.00');
      expect(row.scheduled_date).toBe('2026-08-15');
      expect(row.notes).toBeNull();
    });

    it('lets the office override the total cost at creation (D2)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);

      const response = await createSurgery(
        office.token,
        surgeryBody(patientId, catalog.id, { totalCost: '7500.00' }),
      );

      expect(response.status).toBe(201);
      expect(response.body.totalCost).toBe('7500.00');
      const row = await surgeryRow(response.body.id as string);
      expect(row.total_cost).toBe('7500.00');
    });

    it('persists optional notes', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);

      const response = await createSurgery(
        office.token,
        surgeryBody(patientId, catalog.id, { notes: 'Requires general anesthesia' }),
      );

      expect(response.status).toBe(201);
      expect(response.body.notes).toBe('Requires general anesthesia');
      const row = await surgeryRow(response.body.id as string);
      expect(row.notes).toBe('Requires general anesthesia');
    });

    it('forbids patient-role users from scheduling surgeries (403)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const patient = await patientToken();

      const response = await createSurgery(
        patient,
        surgeryBody(patientId, catalog.id),
      );

      expect(response.status).toBe(403);
    });

    it('returns 404 when the patient does not exist', async () => {
      const office = await officeUser();
      const catalog = await createCatalogEntry(office.token);

      const response = await createSurgery(
        office.token,
        surgeryBody('00000000-0000-4000-8000-000000000000', catalog.id),
      );

      expect(response.status).toBe(404);
    });

    it('returns 404 when the catalog entry does not exist', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();

      const response = await createSurgery(
        office.token,
        surgeryBody(patientId, '00000000-0000-4000-8000-000000000000'),
      );

      expect(response.status).toBe(404);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const response = await request(app.getHttpServer()).post('/api/surgeries');
      expect(response.status).toBe(401);
    });
  });

  describe('surgery updates (total_cost edit rejected once a plan exists)', () => {
    it('lets the office update notes and scheduled date', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);

      const response = await updateSurgery(office.token, created.body.id as string, {
        notes: 'Postponed by one week',
        scheduledDate: '2026-08-22',
      });

      expect(response.status).toBe(200);
      expect(response.body.notes).toBe('Postponed by one week');
      const row = await surgeryRow(created.body.id as string);
      expect(row.notes).toBe('Postponed by one week');
      expect(row.scheduled_date).toBe('2026-08-22');
    });

    it('lets the office update total_cost while no payment plan exists', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);

      const response = await updateSurgery(office.token, created.body.id as string, {
        totalCost: '6900.00',
      });

      expect(response.status).toBe(200);
      expect(response.body.totalCost).toBe('6900.00');
      const row = await surgeryRow(created.body.id as string);
      expect(row.total_cost).toBe('6900.00');
    });

    it('rejects a total_cost edit with 409 once a payment plan exists and persists nothing', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      await dataSource.query(
        `INSERT INTO payment_plans (surgery_id, type, financed_amount, installment_count, start_date, outstanding_balance)
         VALUES ($1, 'upfront', $2, 1, '2026-08-15', $2)`,
        [created.body.id as string, '8000.00'],
      );

      const response = await updateSurgery(office.token, created.body.id as string, {
        totalCost: '6000.00',
      });

      expect(response.status).toBe(409);
      const row = await surgeryRow(created.body.id as string);
      expect(row.total_cost).toBe('8000.00');
    });

    it('forbids patient-role users from updating surgeries (403)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const patient = await patientToken();

      const response = await updateSurgery(patient, created.body.id as string, {
        notes: 'Hacked',
      });

      expect(response.status).toBe(403);
    });
  });

  describe('status transitions (T6: audited in the same transaction)', () => {
    it('marks a scheduled surgery as performed and writes one audit entry in the same transaction', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);

      const response = await updateSurgeryStatus(office.token, created.body.id as string, {
        status: SurgeryStatus.PERFORMED,
      });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe(SurgeryStatus.PERFORMED);
      const row = await surgeryRow(created.body.id as string);
      expect(row.status).toBe(SurgeryStatus.PERFORMED);

      const audit = await auditRows(created.body.id as string);
      expect(audit).toHaveLength(1);
      expect(audit[0].user_id).toBe(office.id);
      expect(audit[0].action).toBe('surgery.status_changed');
      expect(audit[0].table_name).toBe('surgeries');
      expect(audit[0].record_id).toBe(created.body.id);
      expect(audit[0].previous_data).toEqual({ status: SurgeryStatus.SCHEDULED });
      expect(audit[0].new_data).toEqual({ status: SurgeryStatus.PERFORMED });
    });

    it('lets an admin transition performed to cancelled with a matching audit entry', async () => {
      const office = await officeUser();
      const admin = await adminToken();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const performed = await updateSurgeryStatus(office.token, created.body.id as string, {
        status: SurgeryStatus.PERFORMED,
      });
      expect(performed.status).toBe(200);

      const response = await updateSurgeryStatus(admin, created.body.id as string, {
        status: SurgeryStatus.CANCELLED,
      });

      expect(response.status).toBe(200);
      const audit = await auditRows(created.body.id as string);
      expect(audit).toHaveLength(2);
      expect(audit[1].previous_data).toEqual({ status: SurgeryStatus.PERFORMED });
      expect(audit[1].new_data).toEqual({ status: SurgeryStatus.CANCELLED });
    });

    it('rejects a status value outside the enum with 400 and writes no audit entry', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);

      const response = await updateSurgeryStatus(office.token, created.body.id as string, {
        status: 'completed',
      });

      expect(response.status).toBe(400);
      const row = await surgeryRow(created.body.id as string);
      expect(row.status).toBe(SurgeryStatus.SCHEDULED);
      const audit = await auditRows(created.body.id as string);
      expect(audit).toHaveLength(0);
    });

    it('returns 404 for an unknown surgery', async () => {
      const office = await officeUser();

      const response = await updateSurgeryStatus(office.token, '00000000-0000-4000-8000-000000000000', {
        status: SurgeryStatus.PERFORMED,
      });

      expect(response.status).toBe(404);
    });

    it('forbids patient-role users from changing surgery status (403)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const patient = await patientToken();

      const response = await updateSurgeryStatus(patient, created.body.id as string, {
        status: SurgeryStatus.PERFORMED,
      });

      expect(response.status).toBe(403);
    });
  });

  describe('doctor assignment (one principal per surgery)', () => {
    it('assigns a doctor as assistant with the given role', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const doctorId = await createDoctorRaw();

      const response = await assignDoctor(office.token, created.body.id as string, {
        doctorId,
        role: SurgeryDoctorRole.ASSISTANT,
      });

      expect(response.status).toBe(201);
      expect(response.body.doctorId).toBe(doctorId);
      expect(response.body.role).toBe(SurgeryDoctorRole.ASSISTANT);
      expect(await roleOf(created.body.id as string, doctorId)).toBe(
        SurgeryDoctorRole.ASSISTANT,
      );
    });

    it('defaults the role to principal for the first assigned doctor', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const doctorId = await createDoctorRaw();

      const response = await assignDoctor(office.token, created.body.id as string, {
        doctorId,
      });

      expect(response.status).toBe(201);
      expect(response.body.role).toBe(SurgeryDoctorRole.PRINCIPAL);
      expect(await principalCount(created.body.id as string)).toBe(1);
    });

    it('rejects a second principal with 409 (partial unique index) and persists nothing', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const firstDoctorId = await createDoctorRaw();
      const secondDoctorId = await createDoctorRaw();
      const first = await assignDoctor(office.token, created.body.id as string, {
        doctorId: firstDoctorId,
        role: SurgeryDoctorRole.PRINCIPAL,
      });
      expect(first.status).toBe(201);

      const response = await assignDoctor(office.token, created.body.id as string, {
        doctorId: secondDoctorId,
        role: SurgeryDoctorRole.PRINCIPAL,
      });

      expect(response.status).toBe(409);
      expect(await principalCount(created.body.id as string)).toBe(1);
      expect(await roleOf(created.body.id as string, firstDoctorId)).toBe(
        SurgeryDoctorRole.PRINCIPAL,
      );
    });

    it('rejects assigning the same doctor twice with any role (409)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const doctorId = await createDoctorRaw();
      const first = await assignDoctor(office.token, created.body.id as string, {
        doctorId,
        role: SurgeryDoctorRole.ANESTHESIOLOGIST,
      });
      expect(first.status).toBe(201);

      const response = await assignDoctor(office.token, created.body.id as string, {
        doctorId,
        role: SurgeryDoctorRole.PRINCIPAL,
      });

      expect(response.status).toBe(409);
      expect(await assignmentCount(created.body.id as string, doctorId)).toBe(1);
      expect(await roleOf(created.body.id as string, doctorId)).toBe(
        SurgeryDoctorRole.ANESTHESIOLOGIST,
      );
    });

    it('returns 404 for an unknown doctor', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);

      const response = await assignDoctor(office.token, created.body.id as string, {
        doctorId: '00000000-0000-4000-8000-000000000000',
        role: SurgeryDoctorRole.ASSISTANT,
      });

      expect(response.status).toBe(404);
    });

    it('returns 404 for an unknown surgery', async () => {
      const office = await officeUser();
      const doctorId = await createDoctorRaw();

      const response = await assignDoctor(office.token, '00000000-0000-4000-8000-000000000000', {
        doctorId,
        role: SurgeryDoctorRole.ASSISTANT,
      });

      expect(response.status).toBe(404);
    });

    it('forbids patient-role users from assigning doctors (403)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const doctorId = await createDoctorRaw();
      const patient = await patientToken();

      const response = await assignDoctor(patient, created.body.id as string, {
        doctorId,
        role: SurgeryDoctorRole.ASSISTANT,
      });

      expect(response.status).toBe(403);
    });

    it('rejects a second principal insert at the database level (partial unique index)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const firstDoctorId = await createDoctorRaw();
      const secondDoctorId = await createDoctorRaw();
      await dataSource.query(
        `INSERT INTO surgery_doctors (surgery_id, doctor_id, role)
         VALUES ($1, $2, 'principal')`,
        [created.body.id as string, firstDoctorId],
      );

      await expect(
        dataSource.query(
          `INSERT INTO surgery_doctors (surgery_id, doctor_id, role)
           VALUES ($1, $2, 'principal')`,
          [created.body.id as string, secondDoctorId],
        ),
      ).rejects.toThrow();
    });
  });

  describe('principal reassignment (T7: atomic demote-then-promote)', () => {
    it('demotes the current principal and promotes the new doctor in one transaction', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const firstDoctorId = await createDoctorRaw();
      const secondDoctorId = await createDoctorRaw();
      const first = await assignDoctor(office.token, created.body.id as string, {
        doctorId: firstDoctorId,
        role: SurgeryDoctorRole.PRINCIPAL,
      });
      expect(first.status).toBe(201);

      const response = await reassignPrincipal(office.token, created.body.id as string, {
        doctorId: secondDoctorId,
      });

      expect(response.status).toBe(201);
      expect(response.body.doctorId).toBe(secondDoctorId);
      expect(response.body.role).toBe(SurgeryDoctorRole.PRINCIPAL);
      // Never 0 or 2 principals: exactly one row keeps the principal role.
      expect(await principalCount(created.body.id as string)).toBe(1);
      expect(await roleOf(created.body.id as string, secondDoctorId)).toBe(
        SurgeryDoctorRole.PRINCIPAL,
      );
      expect(await roleOf(created.body.id as string, firstDoctorId)).toBe(
        SurgeryDoctorRole.ASSISTANT,
      );
    });

    it('promotes an already-assigned assistant in place without inserting a second row', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const firstDoctorId = await createDoctorRaw();
      const secondDoctorId = await createDoctorRaw();
      await assignDoctor(office.token, created.body.id as string, {
        doctorId: firstDoctorId,
        role: SurgeryDoctorRole.PRINCIPAL,
      });
      await assignDoctor(office.token, created.body.id as string, {
        doctorId: secondDoctorId,
        role: SurgeryDoctorRole.ASSISTANT,
      });

      const response = await reassignPrincipal(office.token, created.body.id as string, {
        doctorId: secondDoctorId,
      });

      expect(response.status).toBe(201);
      expect(await principalCount(created.body.id as string)).toBe(1);
      expect(await roleOf(created.body.id as string, secondDoctorId)).toBe(
        SurgeryDoctorRole.PRINCIPAL,
      );
      expect(await roleOf(created.body.id as string, firstDoctorId)).toBe(
        SurgeryDoctorRole.ASSISTANT,
      );
      expect(await assignmentCount(created.body.id as string, secondDoctorId)).toBe(1);
    });

    it('rolls back the demotion when the target doctor does not exist (atomicity)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const firstDoctorId = await createDoctorRaw();
      const first = await assignDoctor(office.token, created.body.id as string, {
        doctorId: firstDoctorId,
        role: SurgeryDoctorRole.PRINCIPAL,
      });
      expect(first.status).toBe(201);

      const response = await reassignPrincipal(office.token, created.body.id as string, {
        doctorId: '00000000-0000-4000-8000-000000000000',
      });

      expect(response.status).toBe(404);
      // The transaction rolled back: D1 is still principal, no partial demote.
      expect(await principalCount(created.body.id as string)).toBe(1);
      expect(await roleOf(created.body.id as string, firstDoctorId)).toBe(
        SurgeryDoctorRole.PRINCIPAL,
      );
    });

    it('rejects reassigning the current principal to itself (409) and changes nothing', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const firstDoctorId = await createDoctorRaw();
      const first = await assignDoctor(office.token, created.body.id as string, {
        doctorId: firstDoctorId,
        role: SurgeryDoctorRole.PRINCIPAL,
      });
      expect(first.status).toBe(201);

      const response = await reassignPrincipal(office.token, created.body.id as string, {
        doctorId: firstDoctorId,
      });

      expect(response.status).toBe(409);
      expect(await principalCount(created.body.id as string)).toBe(1);
      expect(await roleOf(created.body.id as string, firstDoctorId)).toBe(
        SurgeryDoctorRole.PRINCIPAL,
      );
    });

    it('promotes the new doctor when the surgery has no principal yet', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const doctorId = await createDoctorRaw();

      const response = await reassignPrincipal(office.token, created.body.id as string, {
        doctorId,
      });

      expect(response.status).toBe(201);
      expect(await principalCount(created.body.id as string)).toBe(1);
      expect(await roleOf(created.body.id as string, doctorId)).toBe(
        SurgeryDoctorRole.PRINCIPAL,
      );
    });

    it('forbids patient-role users from reassigning the principal (403)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const created = await createSurgery(office.token, surgeryBody(patientId, catalog.id));
      expect(created.status).toBe(201);
      const doctorId = await createDoctorRaw();
      const patient = await patientToken();

      const response = await reassignPrincipal(patient, created.body.id as string, {
        doctorId,
      });

      expect(response.status).toBe(403);
    });
  });

  describe('surgery list (design section 4: staff-only GET /api/surgeries)', () => {
    function listSurgeries(token: string, query: Record<string, unknown>) {
      return request(app.getHttpServer())
        .get('/api/surgeries')
        .set('Authorization', `Bearer ${token}`)
        .query(query);
    }

    it('returns the pagination envelope with nested patient, catalog and doctor relations for office users', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const doctorId = await createDoctorRaw();
      // 2999 dates pin the rows at the top of the DESC order: the shared DB
      // accumulates rows from every run, so mid-list dates drift behind.
      const created = await createSurgery(
        office.token,
        surgeryBody(patientId, catalog.id, { scheduledDate: '2999-01-05' }),
      );
      expect(created.status).toBe(201);
      const assigned = await assignDoctor(office.token, created.body.id as string, {
        doctorId,
        role: SurgeryDoctorRole.ASSISTANT,
      });
      expect(assigned.status).toBe(201);

      const response = await listSurgeries(office.token, { limit: 100, offset: 0 });

      expect(response.status).toBe(200);
      expect(response.body.data).toBeInstanceOf(Array);
      expect(response.body).toHaveProperty('total');
      expect(response.body.limit).toBe(100);
      expect(response.body.offset).toBe(0);
      const row = response.body.data.find(
        (surgery: { id: string }) => surgery.id === created.body.id,
      );
      expect(row).toBeDefined();
      expect(row.patient.id).toBe(patientId);
      expect(row.surgeryCatalog.id).toBe(catalog.id);
      expect(row.surgeryDoctors).toHaveLength(1);
      expect(row.surgeryDoctors[0].doctor.id).toBe(doctorId);
      expect(row.surgeryDoctors[0].role).toBe(SurgeryDoctorRole.ASSISTANT);
    });

    it('orders surgeries by scheduledDate DESC (newest first)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      // 2999 dates pin the pair at the top of the DESC order (the shared DB
      // accumulates rows from every run, so mid-list dates drift past the
      // page window); the two rows keep a fixed mutual order either way.
      const later = await createSurgery(
        office.token,
        surgeryBody(patientId, catalog.id, { scheduledDate: '2999-01-10' }),
      );
      expect(later.status).toBe(201);
      const earlier = await createSurgery(
        office.token,
        surgeryBody(patientId, catalog.id, { scheduledDate: '2999-01-08' }),
      );
      expect(earlier.status).toBe(201);

      const response = await listSurgeries(office.token, { limit: 100, offset: 0 });

      expect(response.status).toBe(200);
      const ids = response.body.data.map(
        (surgery: { id: string }) => surgery.id as string,
      );
      expect(ids.indexOf(later.body.id as string)).toBeLessThan(
        ids.indexOf(earlier.body.id as string),
      );
    });

    it('reports the real surgery count without hasMany duplication and offset pages neither skip nor repeat', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      // AD7 pin: one surgery with three assigned doctors and one with a single
      // doctor — getManyAndCount must still count each surgery once.
      const heavy = await createSurgery(
        office.token,
        surgeryBody(patientId, catalog.id, { scheduledDate: '2999-02-01' }),
      );
      expect(heavy.status).toBe(201);
      for (let i = 0; i < 3; i++) {
        const doctorId = await createDoctorRaw();
        const assigned = await assignDoctor(office.token, heavy.body.id as string, {
          doctorId,
          role:
            i === 0
              ? SurgeryDoctorRole.PRINCIPAL
              : SurgeryDoctorRole.ASSISTANT,
        });
        expect(assigned.status).toBe(201);
      }
      const light = await createSurgery(
        office.token,
        surgeryBody(patientId, catalog.id, { scheduledDate: '2999-02-02' }),
      );
      expect(light.status).toBe(201);
      const lightDoctorId = await createDoctorRaw();
      const lightAssigned = await assignDoctor(
        office.token,
        light.body.id as string,
        { doctorId: lightDoctorId, role: SurgeryDoctorRole.PRINCIPAL },
      );
      expect(lightAssigned.status).toBe(201);

      const dbCount: { count: string }[] = await dataSource.query(
        'SELECT COUNT(*)::text AS count FROM surgeries',
      );

      // Offset paging over the full range: exactly `total` rows, every row
      // exactly once — nothing skipped, nothing repeated.
      const paged: string[] = [];
      let page: { data: { id: string }[]; total: number };
      do {
        page = (await listSurgeries(office.token, { limit: 10, offset: paged.length })).body;
        expect(page.total).toBe(Number(dbCount[0].count));
        for (const row of page.data) paged.push(row.id);
      } while (paged.length < page.total);

      expect(paged).toHaveLength(Number(dbCount[0].count));
      expect(new Set(paged).size).toBe(paged.length);
      expect(paged.filter((id) => id === heavy.body.id)).toHaveLength(1);
      expect(paged.filter((id) => id === light.body.id)).toHaveLength(1);
    });

    it('forbids patient-role users from listing surgeries (403)', async () => {
      const patient = await patientToken();

      const response = await listSurgeries(patient, { limit: 10, offset: 0 });

      expect(response.status).toBe(403);
    });

    it('forbids doctor-role users from listing surgeries (403)', async () => {
      const doctorUserId = await insertUserRaw(
        emailFor(`doctor.list.surgeries.${uniqueCounter++}`),
        'Doctor List Surgeries',
        UserRole.DOCTOR,
      );

      const response = await listSurgeries(await tokenForUserId(doctorUserId), {
        limit: 10,
        offset: 0,
      });

      expect(response.status).toBe(403);
    });

    it('rejects unauthenticated list requests with 401', async () => {
      const response = await request(app.getHttpServer()).get('/api/surgeries');
      expect(response.status).toBe(401);
    });
  });
});
