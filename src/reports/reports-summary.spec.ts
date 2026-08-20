import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

// La suite comparte db_creditos_test con las demas, que corren en paralelo y
// tambien crean planes y pagos. Por eso NINGUNA assertion mira valores
// absolutos: se toma el resumen antes, se inserta un fixture conocido y se
// verifica el DELTA. Asi el spec sigue siendo correcto aunque otra suite
// escriba al mismo tiempo.
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
// `patients.identity_document` es varchar(20) y ademas unico: el sufijo corto
// entra en la columna y sigue siendo unico entre corridas concurrentes.
const SHORT_SUFFIX = RUN_SUFFIX.slice(-10);
let uniqueCounter = 0;

interface IdRow {
  id: string;
}

interface SummaryBody {
  collected: string;
  pendingConfirmation: { count: number; amount: string };
  outstandingPortfolio: string;
  overdue: { count: number; amount: string };
  dueNext7Days: { count: number; amount: string };
  plansByStatus: Record<string, number>;
}

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

describe('GET /api/reports/summary', () => {
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

  async function insertUser(role: UserRole): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, 'hashed-password', $2, $3, true)
       RETURNING id`,
      [
        `reports.${role}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`,
        `Reports ${role}`,
        role,
      ],
    );
    return rows[0].id;
  }

  async function tokenFor(role: UserRole): Promise<string> {
    return jwtService.sign({ id: await insertUser(role) });
  }

  async function insertPlanFixture(): Promise<void> {
    const patientRows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Reporte', 'Cobranza', $2)
       RETURNING id`,
      [
        `D${SHORT_SUFFIX}${uniqueCounter++}`,
        `+591${SHORT_SUFFIX}${uniqueCounter++}`,
      ],
    );
    const catalogRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, base_cost)
       VALUES ($1, '5000.00')
       RETURNING id`,
      [`Reporte-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    const surgeryRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, $3, '5000.00')
       RETURNING id`,
      [patientRows[0].id, catalogRows[0].id, isoDaysFromToday(-30)],
    );
    const planRows: IdRow[] = await dataSource.query(
      `INSERT INTO payment_plans
         (surgery_id, type, down_payment, financed_amount, monthly_interest_rate,
          installment_count, start_date, outstanding_balance, status)
       VALUES ($1, 'credit', '0.00', '1000.00', '2.00', 3, $2, '1000.00', 'active')
       RETURNING id`,
      [surgeryRows[0].id, isoDaysFromToday(-30)],
    );
    const planId = planRows[0].id;

    // Cuota 1: vencida hace 5 dias, sin pagar -> suma 300.00 a mora.
    // Cuota 2: vence en 3 dias, con 50.00 ya pagados -> suma 250.00 a los
    //          proximos 7 dias (lo que todavia falta cobrar).
    // Cuota 3: vence en 40 dias -> no entra en ningun bucket.
    const installmentRows: IdRow[] = await dataSource.query(
      `INSERT INTO installments
         (payment_plan_id, installment_number, principal_amount, interest_amount,
          total_amount, paid_amount, due_date, status)
       VALUES
         ($1, 1, '300.00', '0.00', '300.00', '0.00', $2, 'pending'),
         ($1, 2, '300.00', '0.00', '300.00', '50.00', $3, 'partial'),
         ($1, 3, '400.00', '0.00', '400.00', '0.00', $4, 'pending')
       RETURNING id`,
      [planId, isoDaysFromToday(-5), isoDaysFromToday(3), isoDaysFromToday(40)],
    );

    const methodRows: IdRow[] = await dataSource.query(
      `INSERT INTO payment_methods (name) VALUES ($1) RETURNING id`,
      [`Efectivo-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    const officeId = await insertUser(UserRole.OFFICE);

    // Un pago confirmado hoy (entra en lo recaudado del mes en curso) y uno
    // pendiente de confirmacion (entra en su propio bucket, NUNCA en lo
    // recaudado).
    await dataSource.query(
      `INSERT INTO payments
         (payment_plan_id, installment_id, recorded_by_user_id, payment_method_id,
          amount, type, paid_at, status)
       VALUES
         ($1, $2, $3, $4, '200.00', 'installment_payment', now(), 'confirmed'),
         ($1, $2, $3, $4, '75.00', 'installment_payment', now(), 'pending_confirmation')`,
      [planId, installmentRows[1].id, officeId, methodRows[0].id],
    );
  }

  function getSummary(token: string) {
    return request(app.getHttpServer())
      .get('/api/reports/summary')
      .set('Authorization', `Bearer ${token}`);
  }

  it('rejects anonymous access', async () => {
    await request(app.getHttpServer()).get('/api/reports/summary').expect(401);
  });

  it('rejects the patient role', async () => {
    const patientToken = await tokenFor(UserRole.PATIENT);
    await getSummary(patientToken).expect(403);
  });

  it('aggregates collections, portfolio, overdue and upcoming buckets', async () => {
    const officeToken = await tokenFor(UserRole.OFFICE);

    const before = await getSummary(officeToken).expect(200);
    await insertPlanFixture();
    const after = await getSummary(officeToken).expect(200);

    const b = before.body as SummaryBody;
    const a = after.body as SummaryBody;

    // Lo recaudado cuenta solo pagos confirmados.
    expect(Number(a.collected) - Number(b.collected)).toBeCloseTo(200, 2);

    expect(a.pendingConfirmation.count - b.pendingConfirmation.count).toBe(1);
    expect(
      Number(a.pendingConfirmation.amount) -
        Number(b.pendingConfirmation.amount),
    ).toBeCloseTo(75, 2);

    // Cartera vigente = saldo pendiente de los planes activos.
    expect(
      Number(a.outstandingPortfolio) - Number(b.outstandingPortfolio),
    ).toBeCloseTo(1000, 2);

    // Mora = lo que falta cobrar de cuotas ya vencidas.
    expect(a.overdue.count - b.overdue.count).toBe(1);
    expect(Number(a.overdue.amount) - Number(b.overdue.amount)).toBeCloseTo(
      300,
      2,
    );

    // Proximos 7 dias = total menos lo ya pagado de esa cuota.
    expect(a.dueNext7Days.count - b.dueNext7Days.count).toBe(1);
    expect(
      Number(a.dueNext7Days.amount) - Number(b.dueNext7Days.amount),
    ).toBeCloseTo(250, 2);

    expect(a.plansByStatus.active - b.plansByStatus.active).toBe(1);
  });

  it('returns money as strings with two decimals', async () => {
    const adminToken = await tokenFor(UserRole.ADMIN);
    const response = await getSummary(adminToken).expect(200);
    const body = response.body as SummaryBody;

    for (const value of [
      body.collected,
      body.outstandingPortfolio,
      body.overdue.amount,
      body.dueNext7Days.amount,
      body.pendingConfirmation.amount,
    ]) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^\d+\.\d{2}$/);
    }
  });
});
