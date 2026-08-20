import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

const RUN_SUFFIX = `${process.pid}${Date.now()}`;
const SHORT_SUFFIX = RUN_SUFFIX.slice(-10);
let uniqueCounter = 0;

interface IdRow {
  id: string;
}

interface SurgeryRow {
  id: string;
}

interface SurgeryListBody {
  data: SurgeryRow[];
  total: number;
}

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Portales de paciente y doctor: cada rol ve SOLO lo suyo, resuelto desde el
 * token y nunca desde un id de la URL. Este spec es la barrera de seguridad de
 * los dos portales.
 */
describe('surgery scoping for the patient and doctor portals', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  // Paciente A tiene una cirugia, atendida por el doctor A.
  // Paciente B tiene otra, atendida por el doctor B. Nadie debe cruzarse.
  let patientAToken: string;
  let patientBToken: string;
  let doctorAToken: string;
  let surgeryAId: string;
  let surgeryBId: string;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);

    const patientAUserId = await insertUser(UserRole.PATIENT);
    const patientBUserId = await insertUser(UserRole.PATIENT);
    const doctorAUserId = await insertUser(UserRole.DOCTOR);
    const doctorBUserId = await insertUser(UserRole.DOCTOR);

    patientAToken = jwtService.sign({ id: patientAUserId });
    patientBToken = jwtService.sign({ id: patientBUserId });
    doctorAToken = jwtService.sign({ id: doctorAUserId });

    const patientAId = await insertPatient(patientAUserId);
    const patientBId = await insertPatient(patientBUserId);
    const doctorAId = await insertDoctor(doctorAUserId);
    const doctorBId = await insertDoctor(doctorBUserId);

    surgeryAId = await insertSurgery(patientAId);
    surgeryBId = await insertSurgery(patientBId);
    await assignDoctor(surgeryAId, doctorAId);
    await assignDoctor(surgeryBId, doctorBId);
  });

  afterAll(async () => {
    await app.close();
  });

  async function insertUser(role: UserRole): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, 'hashed-password', $2, $3, true)
       RETURNING id`,
      [
        `portal.${role}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`,
        `Portal ${role}`,
        role,
      ],
    );
    return rows[0].id;
  }

  async function insertPatient(userId: string): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (user_id, identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, $2, 'Paciente', 'Portal', $3)
       RETURNING id`,
      [
        userId,
        `P${SHORT_SUFFIX}${uniqueCounter++}`,
        `+591${SHORT_SUFFIX}${uniqueCounter++}`,
      ],
    );
    return rows[0].id;
  }

  async function insertDoctor(userId: string): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO doctors
         (user_id, specialty, professional_license, first_name, paternal_last_name, phone)
       VALUES ($1, 'Cirugia general', $2, 'Doctor', 'Portal', $3)
       RETURNING id`,
      [
        userId,
        `LIC${SHORT_SUFFIX}${uniqueCounter++}`,
        `+5917${SHORT_SUFFIX}${uniqueCounter++}`,
      ],
    );
    return rows[0].id;
  }

  async function insertSurgery(patientId: string): Promise<string> {
    const catalogRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, base_cost)
       VALUES ($1, '4000.00') RETURNING id`,
      [`Portal-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, $3, '4000.00')
       RETURNING id`,
      [patientId, catalogRows[0].id, isoDaysFromToday(10)],
    );
    return rows[0].id;
  }

  async function assignDoctor(
    surgeryId: string,
    doctorId: string,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO surgery_doctors (surgery_id, doctor_id, role)
       VALUES ($1, $2, 'principal')`,
      [surgeryId, doctorId],
    );
  }

  function listSurgeries(token: string) {
    return request(app.getHttpServer())
      .get('/api/surgeries?limit=200')
      .set('Authorization', `Bearer ${token}`);
  }

  function getSurgery(token: string, id: string) {
    return request(app.getHttpServer())
      .get(`/api/surgeries/${id}`)
      .set('Authorization', `Bearer ${token}`);
  }

  it('still rejects anonymous access', async () => {
    await request(app.getHttpServer()).get('/api/surgeries').expect(401);
  });

  it('lets a patient list their own surgeries', async () => {
    const response = await listSurgeries(patientAToken).expect(200);
    const body = response.body as SurgeryListBody;
    const ids = body.data.map((surgery) => surgery.id);

    expect(ids).toContain(surgeryAId);
  });

  it('never leaks another patient surgery into the list', async () => {
    const response = await listSurgeries(patientAToken).expect(200);
    const body = response.body as SurgeryListBody;
    const ids = body.data.map((surgery) => surgery.id);

    expect(ids).not.toContain(surgeryBId);
  });

  it('blocks a patient reading another patient surgery by id', async () => {
    await getSurgery(patientBToken, surgeryAId).expect(403);
  });

  it('lets a patient read their own surgery by id', async () => {
    await getSurgery(patientAToken, surgeryAId).expect(200);
  });

  it('lets a doctor list only the surgeries they are assigned to', async () => {
    const response = await listSurgeries(doctorAToken).expect(200);
    const body = response.body as SurgeryListBody;
    const ids = body.data.map((surgery) => surgery.id);

    expect(ids).toContain(surgeryAId);
    expect(ids).not.toContain(surgeryBId);
  });

  it('blocks a doctor reading a surgery they are not assigned to', async () => {
    await getSurgery(doctorAToken, surgeryBId).expect(403);
  });

  it('keeps staff seeing every surgery', async () => {
    const officeUserId = await insertUser(UserRole.OFFICE);
    const officeToken = jwtService.sign({ id: officeUserId });

    const response = await listSurgeries(officeToken).expect(200);
    const body = response.body as SurgeryListBody;
    const ids = body.data.map((surgery) => surgery.id);

    expect(ids).toContain(surgeryAId);
    expect(ids).toContain(surgeryBId);
  });

  it('keeps write operations closed to patients and doctors', async () => {
    await request(app.getHttpServer())
      .patch(`/api/surgeries/${surgeryAId}`)
      .set('Authorization', `Bearer ${patientAToken}`)
      .send({ notes: 'intento' })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/api/surgeries/${surgeryAId}/status`)
      .set('Authorization', `Bearer ${doctorAToken}`)
      .send({ status: 'performed' })
      .expect(403);
  });
});
