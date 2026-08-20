import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

// Igual que reports-summary.spec.ts: la base es compartida, asi que el spec
// busca SUS filas dentro de la respuesta en vez de asumir que son las unicas.
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
const SHORT_SUFFIX = RUN_SUFFIX.slice(-10);
let uniqueCounter = 0;

interface IdRow {
  id: string;
}

interface OverdueRow {
  installmentId: string;
  planId: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
  installmentNumber: number;
  dueDate: string;
  amountDue: string;
  daysOverdue: number;
}

interface OverdueBody {
  data: OverdueRow[];
  total: number;
  limit: number;
  offset: number;
}

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

describe('GET /api/reports/overdue-installments', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let patientId: string;
  let planId: string;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
    ({ patientId, planId } = await insertFixture());
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
        `overdue.${role}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`,
        `Overdue ${role}`,
        role,
      ],
    );
    return rows[0].id;
  }

  async function tokenFor(role: UserRole): Promise<string> {
    return jwtService.sign({ id: await insertUser(role) });
  }

  async function insertFixture(): Promise<{
    patientId: string;
    planId: string;
  }> {
    const patientRows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Rosa', 'Quispe', $2)
       RETURNING id`,
      [
        `O${SHORT_SUFFIX}${uniqueCounter++}`,
        `+591${SHORT_SUFFIX}${uniqueCounter++}`,
      ],
    );
    const catalogRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, base_cost)
       VALUES ($1, '5000.00')
       RETURNING id`,
      [`Mora-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    const surgeryRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, $3, '5000.00')
       RETURNING id`,
      [patientRows[0].id, catalogRows[0].id, isoDaysFromToday(-90)],
    );
    const planRows: IdRow[] = await dataSource.query(
      `INSERT INTO payment_plans
         (surgery_id, type, down_payment, financed_amount, monthly_interest_rate,
          installment_count, start_date, outstanding_balance, status)
       VALUES ($1, 'credit', '0.00', '900.00', '2.00', 3, $2, '900.00', 'active')
       RETURNING id`,
      [surgeryRows[0].id, isoDaysFromToday(-90)],
    );

    // Cuota 1: vencida hace 40 dias, impaga -> debe aparecer primera (mas dias).
    // Cuota 2: vencida hace 10 dias, con pago parcial -> aparece con el saldo.
    // Cuota 3: ya pagada -> NO debe aparecer.
    await dataSource.query(
      `INSERT INTO installments
         (payment_plan_id, installment_number, principal_amount, interest_amount,
          total_amount, paid_amount, due_date, status)
       VALUES
         ($1, 1, '300.00', '0.00', '300.00', '0.00', $2, 'overdue'),
         ($1, 2, '300.00', '0.00', '300.00', '120.00', $3, 'partial'),
         ($1, 3, '300.00', '0.00', '300.00', '300.00', $4, 'paid')`,
      [
        planRows[0].id,
        isoDaysFromToday(-40),
        isoDaysFromToday(-10),
        isoDaysFromToday(-70),
      ],
    );

    return { patientId: patientRows[0].id, planId: planRows[0].id };
  }

  function getOverdue(token: string, query = '') {
    return request(app.getHttpServer())
      .get(`/api/reports/overdue-installments${query}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function ownRows(body: OverdueBody): OverdueRow[] {
    return body.data.filter((row) => row.planId === planId);
  }

  /**
   * La base de test es compartida y, cuando corre la suite completa, tiene
   * cientos de cuotas vencidas mas antiguas que las de este fixture. Como el
   * endpoint ordena por antiguedad, las filas propias pueden caer en cualquier
   * pagina: hay que recorrerlas todas en vez de asumir que entran en la
   * primera.
   */
  async function collectOwnRows(token: string): Promise<OverdueRow[]> {
    const pageSize = 200;
    const collected: OverdueRow[] = [];
    let offset = 0;
    let total = Number.POSITIVE_INFINITY;

    while (offset < total) {
      const response = await getOverdue(
        token,
        `?limit=${pageSize}&offset=${offset}`,
      ).expect(200);
      const body = response.body as OverdueBody;
      total = body.total;
      collected.push(...ownRows(body));
      if (body.data.length === 0) break;
      offset += pageSize;
    }

    return collected;
  }

  it('rejects anonymous access', async () => {
    await request(app.getHttpServer())
      .get('/api/reports/overdue-installments')
      .expect(401);
  });

  it('rejects the patient role', async () => {
    const patientToken = await tokenFor(UserRole.PATIENT);
    await getOverdue(patientToken).expect(403);
  });

  it('lists unsettled overdue installments with the patient behind them', async () => {
    const officeToken = await tokenFor(UserRole.OFFICE);
    const rows = await collectOwnRows(officeToken);

    // La cuota 3 esta pagada: quedan dos.
    expect(rows).toHaveLength(2);

    const first = rows.find((row) => row.installmentNumber === 1);
    expect(first).toBeDefined();
    expect(first?.patientId).toBe(patientId);
    expect(first?.patientName).toContain('Rosa');
    expect(first?.patientPhone).toContain(SHORT_SUFFIX);
    expect(first?.amountDue).toBe('300.00');
    expect(first?.daysOverdue).toBe(40);

    // Con pago parcial, lo que se reclama es el saldo, no el total.
    const second = rows.find((row) => row.installmentNumber === 2);
    expect(second?.amountDue).toBe('180.00');
    expect(second?.daysOverdue).toBe(10);
  });

  it('orders by days overdue, most overdue first', async () => {
    const officeToken = await tokenFor(UserRole.OFFICE);
    const rows = await collectOwnRows(officeToken);

    expect(rows[0].daysOverdue).toBeGreaterThan(rows[1].daysOverdue);
  });

  it('paginates with the same shape as the other list endpoints', async () => {
    const adminToken = await tokenFor(UserRole.ADMIN);
    const response = await getOverdue(adminToken, '?limit=1&offset=0').expect(
      200,
    );
    const body = response.body as OverdueBody;

    expect(body.data).toHaveLength(1);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(0);
    expect(body.total).toBeGreaterThanOrEqual(2);
  });
});
