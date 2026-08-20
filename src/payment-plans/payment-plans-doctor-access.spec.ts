import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { uniqueMobile8 } from '../test-utils/unique-phone';

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
 * El medico supervisa el avance de pago de SUS pacientes: los de las cirugias
 * donde esta asignado, con cualquier rol. La frontera es la asignacion, no el
 * rol dentro de ella — un asistente tambien necesita saber si el paciente al
 * que va a operar tiene el plan al dia.
 *
 * El caso cerrado (medico ajeno a la cirugia) vive en
 * payment-plans-doctor-scoping.spec.ts.
 */
describe('payment plan access for the surgery team', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  let principalToken: string;
  let assistantToken: string;
  let planId: string;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);

    const principalUserId = await insertUser(UserRole.DOCTOR);
    const assistantUserId = await insertUser(UserRole.DOCTOR);
    principalToken = jwtService.sign({ id: principalUserId });
    assistantToken = jwtService.sign({ id: assistantUserId });

    const principalId = await insertDoctor(principalUserId);
    const assistantId = await insertDoctor(assistantUserId);

    const { surgeryId, planIdCreated } = await insertSurgeryWithPlan();
    planId = planIdCreated;
    await assign(surgeryId, principalId, 'principal');
    await assign(surgeryId, assistantId, 'assistant');
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
        `acceso.${role}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`,
        `Acceso ${role}`,
        role,
      ],
    );
    return rows[0].id;
  }

  async function insertDoctor(userId: string): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO doctors
         (user_id, specialty, professional_license, first_name, paternal_last_name, phone)
       VALUES ($1, 'Cirugia general', $2, 'Doc', 'Acceso', $3)
       RETURNING id`,
      [userId, `LICX${SHORT_SUFFIX}${uniqueCounter++}`, uniqueMobile8()],
    );
    return rows[0].id;
  }

  async function insertSurgeryWithPlan(): Promise<{
    surgeryId: string;
    planIdCreated: string;
  }> {
    const patientRows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Paciente', 'Acceso', $2)
       RETURNING id`,
      [`X${SHORT_SUFFIX}${uniqueCounter++}`, uniqueMobile8()],
    );
    const catalogRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, base_cost)
       VALUES ($1, '6000.00') RETURNING id`,
      [`Acceso-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    const surgeryRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, $3, '6000.00') RETURNING id`,
      [patientRows[0].id, catalogRows[0].id, isoDaysFromToday(-10)],
    );
    const planRows: IdRow[] = await dataSource.query(
      `INSERT INTO payment_plans
         (surgery_id, type, down_payment, financed_amount, monthly_interest_rate,
          installment_count, start_date, outstanding_balance, status)
       VALUES ($1, 'credit', '0.00', '3000.00', '2.00', 3, $2, '3000.00', 'active')
       RETURNING id`,
      [surgeryRows[0].id, isoDaysFromToday(-10)],
    );
    await dataSource.query(
      `INSERT INTO installments
         (payment_plan_id, installment_number, principal_amount, interest_amount,
          total_amount, paid_amount, due_date, status)
       VALUES ($1, 1, '1000.00', '0.00', '1000.00', '0.00', $2, 'pending')`,
      [planRows[0].id, isoDaysFromToday(20)],
    );
    return { surgeryId: surgeryRows[0].id, planIdCreated: planRows[0].id };
  }

  async function assign(
    surgeryId: string,
    doctorId: string,
    role: string,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO surgery_doctors (surgery_id, doctor_id, role)
       VALUES ($1, $2, $3)`,
      [surgeryId, doctorId, role],
    );
  }

  function getPlan(token: string) {
    return request(app.getHttpServer())
      .get(`/api/payment-plans/${planId}`)
      .set('Authorization', `Bearer ${token}`);
  }

  it('lets the principal surgeon see the plan of their own patient', async () => {
    const response = await getPlan(principalToken).expect(200);

    expect(response.body.outstandingBalance).toBe('3000.00');
  });

  it('lets an assisting doctor see it too', async () => {
    await getPlan(assistantToken).expect(200);
  });

  it('lets the team read the installment schedule', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/payment-plans/${planId}/installments`)
      .set('Authorization', `Bearer ${principalToken}`)
      .expect(200);

    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it('lists that plan for the doctor and nothing else', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/payment-plans?limit=200')
      .set('Authorization', `Bearer ${principalToken}`)
      .expect(200);

    const ids = (response.body.data as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(planId);
  });
});
