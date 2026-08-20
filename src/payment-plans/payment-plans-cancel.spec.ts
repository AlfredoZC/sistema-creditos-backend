import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { PaymentPlanStatus, UserRole } from '../common/enums';
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

interface InstallmentRow {
  installment_number: number;
  status: string;
}

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Anular un plan: la deuda deja de cobrarse aunque el paciente no haya
 * terminado de pagarla (la cirugia no se hizo, se rearmo el financiamiento, se
 * cargo mal).
 *
 * Es una decision administrativa e irreversible, asi que exige motivo y queda
 * auditada. Las cuotas ya pagadas NO se tocan: la plata que entro, entro.
 */
describe('POST /api/payment-plans/:id/cancel', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  let officeToken: string;
  let patientToken: string;
  let doctorToken: string;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);

    officeToken = jwtService.sign({ id: await insertUser(UserRole.OFFICE) });
    patientToken = jwtService.sign({ id: await insertUser(UserRole.PATIENT) });
    doctorToken = jwtService.sign({ id: await insertUser(UserRole.DOCTOR) });
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
        `anular.${role}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`,
        `Anular ${role}`,
        role,
      ],
    );
    return rows[0].id;
  }

  /** Plan con tres cuotas: una pagada, una parcial y una pendiente. */
  async function insertPlan(
    status: PaymentPlanStatus = PaymentPlanStatus.ACTIVE,
  ): Promise<string> {
    const patientRows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Paciente', 'Anular', $2)
       RETURNING id`,
      [`N${SHORT_SUFFIX}${uniqueCounter++}`, uniqueMobile8()],
    );
    const catalogRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, base_cost)
       VALUES ($1, '9000.00') RETURNING id`,
      [`Anular-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    const surgeryRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, $3, '9000.00') RETURNING id`,
      [patientRows[0].id, catalogRows[0].id, isoDaysFromToday(-40)],
    );
    const planRows: IdRow[] = await dataSource.query(
      `INSERT INTO payment_plans
         (surgery_id, type, down_payment, financed_amount, monthly_interest_rate,
          installment_count, start_date, outstanding_balance, status)
       VALUES ($1, 'credit', '0.00', '900.00', '2.00', 3, $2, '600.00', $3)
       RETURNING id`,
      [surgeryRows[0].id, isoDaysFromToday(-40), status],
    );
    await dataSource.query(
      `INSERT INTO installments
         (payment_plan_id, installment_number, principal_amount, interest_amount,
          total_amount, paid_amount, due_date, status)
       VALUES
         ($1, 1, '300.00', '0.00', '300.00', '300.00', $2, 'paid'),
         ($1, 2, '300.00', '0.00', '300.00', '100.00', $3, 'partial'),
         ($1, 3, '300.00', '0.00', '300.00', '0.00', $4, 'pending')`,
      [
        planRows[0].id,
        isoDaysFromToday(-30),
        isoDaysFromToday(-5),
        isoDaysFromToday(25),
      ],
    );
    return planRows[0].id;
  }

  function cancelPlan(
    token: string,
    planId: string,
    reason = 'Cirugia suspendida',
  ) {
    return request(app.getHttpServer())
      .post(`/api/payment-plans/${planId}/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send({ reason });
  }

  async function installmentsOf(planId: string): Promise<InstallmentRow[]> {
    return dataSource.query(
      `SELECT installment_number, status FROM installments
        WHERE payment_plan_id = $1 ORDER BY installment_number`,
      [planId],
    );
  }

  it('anula el plan y deja constancia del motivo', async () => {
    const planId = await insertPlan();

    const response = await cancelPlan(
      officeToken,
      planId,
      'La cirugia no se realizo',
    ).expect(200);

    expect(response.body.status).toBe(PaymentPlanStatus.CANCELLED);

    const audits: { action: string; new_data: { reason?: string } }[] =
      await dataSource.query(
        `SELECT action, new_data FROM audit_logs
          WHERE record_id = $1 AND action = 'payment_plan.cancelled'`,
        [planId],
      );
    expect(audits).toHaveLength(1);
    expect(audits[0].new_data.reason).toBe('La cirugia no se realizo');
  });

  // El punto del estado: dejar de cobrar. Una cuota que sigue "pendiente"
  // seguiria apareciendo en mora y disparando recordatorios.
  it('anula las cuotas que quedaban por cobrar', async () => {
    const planId = await insertPlan();

    await cancelPlan(officeToken, planId).expect(200);

    const installments = await installmentsOf(planId);
    expect(installments[1].status).toBe('cancelled');
    expect(installments[2].status).toBe('cancelled');
  });

  // La plata que entro, entro: el historial no se reescribe.
  it('no toca las cuotas ya pagadas', async () => {
    const planId = await insertPlan();

    await cancelPlan(officeToken, planId).expect(200);

    const installments = await installmentsOf(planId);
    expect(installments[0].status).toBe('paid');
  });

  it('exige un motivo', async () => {
    const planId = await insertPlan();

    await request(app.getHttpServer())
      .post(`/api/payment-plans/${planId}/cancel`)
      .set('Authorization', `Bearer ${officeToken}`)
      .send({})
      .expect(400);
  });

  it('no permite anular dos veces', async () => {
    const planId = await insertPlan();

    await cancelPlan(officeToken, planId).expect(200);
    await cancelPlan(officeToken, planId).expect(409);
  });

  // Un plan pagado ya termino: anularlo borraria un final legitimo.
  it('no permite anular un plan ya pagado', async () => {
    const planId = await insertPlan(PaymentPlanStatus.COMPLETED);

    await cancelPlan(officeToken, planId).expect(409);
  });

  it('esta cerrado para pacientes y medicos', async () => {
    const planId = await insertPlan();

    await cancelPlan(patientToken, planId).expect(403);
    await cancelPlan(doctorToken, planId).expect(403);
  });

  it('rechaza a un anonimo', async () => {
    const planId = await insertPlan();

    await request(app.getHttpServer())
      .post(`/api/payment-plans/${planId}/cancel`)
      .send({ reason: 'intento' })
      .expect(401);
  });
});
