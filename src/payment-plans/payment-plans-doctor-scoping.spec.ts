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

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * El chequeo de propiedad de un plan solo contemplaba el rol `patient`, asi que
 * cualquier otro rol no-staff (doctor) caia en la rama permisiva y podia leer
 * la situacion financiera completa de un paciente ajeno.
 *
 * Decision de producto del portal del doctor: el doctor ve sus cirugias y los
 * datos de contacto del paciente, NO su deuda ni sus cuotas.
 */
describe('payment plan access is closed to doctors', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let doctorToken: string;
  let planId: string;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);

    const doctorUserId = await insertUser(UserRole.DOCTOR);
    doctorToken = jwtService.sign({ id: doctorUserId });
    await insertDoctor(doctorUserId);

    const patientUserId = await insertUser(UserRole.PATIENT);
    planId = await insertPlanFor(await insertPatient(patientUserId));
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
        `plans.${role}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`,
        `Plans ${role}`,
        role,
      ],
    );
    return rows[0].id;
  }

  async function insertDoctor(userId: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO doctors
         (user_id, specialty, professional_license, first_name, paternal_last_name, phone)
       VALUES ($1, 'Traumatologia', $2, 'Doc', 'Planes', $3)`,
      [
        userId,
        `LICP${SHORT_SUFFIX}${uniqueCounter++}`,
        `+5918${SHORT_SUFFIX}${uniqueCounter++}`,
      ],
    );
  }

  async function insertPatient(userId: string): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (user_id, identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, $2, 'Pac', 'Planes', $3)
       RETURNING id`,
      [
        userId,
        `PP${SHORT_SUFFIX}${uniqueCounter++}`,
        `+5919${SHORT_SUFFIX}${uniqueCounter++}`,
      ],
    );
    return rows[0].id;
  }

  async function insertPlanFor(patientId: string): Promise<string> {
    const catalogRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, base_cost)
       VALUES ($1, '7000.00') RETURNING id`,
      [`PlanDoc-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    const surgeryRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, $3, '7000.00') RETURNING id`,
      [patientId, catalogRows[0].id, isoDaysFromToday(-20)],
    );
    const planRows: IdRow[] = await dataSource.query(
      `INSERT INTO payment_plans
         (surgery_id, type, down_payment, financed_amount, monthly_interest_rate,
          installment_count, start_date, outstanding_balance, status)
       VALUES ($1, 'credit', '0.00', '2000.00', '2.00', 4, $2, '2000.00', 'active')
       RETURNING id`,
      [surgeryRows[0].id, isoDaysFromToday(-20)],
    );
    return planRows[0].id;
  }

  it('forbids a doctor from reading a payment plan detail', async () => {
    await request(app.getHttpServer())
      .get(`/api/payment-plans/${planId}`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .expect(403);
  });

  it('forbids a doctor from reading the installment schedule', async () => {
    await request(app.getHttpServer())
      .get(`/api/payment-plans/${planId}/installments`)
      .set('Authorization', `Bearer ${doctorToken}`)
      .expect(403);
  });

  it('keeps the list empty for a doctor instead of leaking other plans', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/payment-plans?limit=200')
      .set('Authorization', `Bearer ${doctorToken}`)
      .expect(200);

    expect(response.body.data).toHaveLength(0);
  });
});
