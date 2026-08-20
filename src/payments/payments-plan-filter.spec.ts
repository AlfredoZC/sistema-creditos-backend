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

interface PaymentRow {
  id: string;
  paymentPlanId: string;
  amount: string;
}

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * El detalle de un plan pedia `GET /api/payments?paymentPlanId=<id>`, pero el
 * endpoint no aceptaba el parametro: lo ignoraba en silencio y devolvia TODOS
 * los pagos del sistema. La pantalla mostraba entonces los pagos de otros
 * pacientes como si fueran de ese plan.
 */
describe('GET /api/payments?paymentPlanId', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  let officeToken: string;
  let officeUserId: string;
  let planA: string;
  let planB: string;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);

    officeUserId = await insertUser(UserRole.OFFICE);
    officeToken = jwtService.sign({ id: officeUserId });

    planA = await insertPlan();
    planB = await insertPlan();
    await insertPayment(planA, '111.11');
    await insertPayment(planA, '222.22');
    await insertPayment(planB, '999.99');
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
        `filtro.${role}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`,
        `Filtro ${role}`,
        role,
      ],
    );
    return rows[0].id;
  }

  async function insertPlan(): Promise<string> {
    const patientRows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Paciente', 'Filtro', $2)
       RETURNING id`,
      [`F${SHORT_SUFFIX}${uniqueCounter++}`, uniqueMobile8()],
    );
    const catalogRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, base_cost)
       VALUES ($1, '5000.00') RETURNING id`,
      [`Filtro-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    const surgeryRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, $3, '5000.00') RETURNING id`,
      [patientRows[0].id, catalogRows[0].id, isoDaysFromToday(-30)],
    );
    const planRows: IdRow[] = await dataSource.query(
      `INSERT INTO payment_plans
         (surgery_id, type, down_payment, financed_amount, monthly_interest_rate,
          installment_count, start_date, outstanding_balance, status)
       VALUES ($1, 'credit', '0.00', '2000.00', '2.00', 2, $2, '2000.00', 'active')
       RETURNING id`,
      [surgeryRows[0].id, isoDaysFromToday(-30)],
    );
    return planRows[0].id;
  }

  async function insertPayment(planId: string, amount: string): Promise<void> {
    const methodRows: IdRow[] = await dataSource.query(
      `INSERT INTO payment_methods (name) VALUES ($1) RETURNING id`,
      [`Metodo-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    await dataSource.query(
      `INSERT INTO payments
         (payment_plan_id, recorded_by_user_id, payment_method_id, amount, type, status)
       VALUES ($1, $2, $3, $4, 'down_payment', 'confirmed')`,
      [planId, officeUserId, methodRows[0].id, amount],
    );
  }

  function listPayments(query = '') {
    return request(app.getHttpServer())
      .get(`/api/payments${query}`)
      .set('Authorization', `Bearer ${officeToken}`);
  }

  it('devuelve solo los pagos del plan pedido', async () => {
    const response = await listPayments(`?paymentPlanId=${planA}`).expect(200);
    const payments = response.body as PaymentRow[];

    expect(payments.length).toBeGreaterThan(0);
    for (const payment of payments) {
      expect(payment.paymentPlanId).toBe(planA);
    }
  });

  it('no filtra por el plan de otro paciente', async () => {
    const response = await listPayments(`?paymentPlanId=${planA}`).expect(200);
    const amounts = (response.body as PaymentRow[]).map((p) => p.amount);

    expect(amounts).toContain('111.11');
    expect(amounts).toContain('222.22');
    expect(amounts).not.toContain('999.99');
  });

  it('sin filtro sigue devolviendo el historial completo al staff', async () => {
    const response = await listPayments().expect(200);
    const planIds = (response.body as PaymentRow[]).map((p) => p.paymentPlanId);

    expect(planIds).toContain(planA);
    expect(planIds).toContain(planB);
  });

  // Un id inventado no debe devolver "todo" por defecto: eso es justamente el
  // fallo que se esta corrigiendo.
  it('devuelve vacio para un plan sin pagos', async () => {
    const emptyPlan = await insertPlan();
    const response = await listPayments(`?paymentPlanId=${emptyPlan}`).expect(
      200,
    );

    expect(response.body).toEqual([]);
  });
});
