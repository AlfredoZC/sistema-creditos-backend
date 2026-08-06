import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import {
  InstallmentStatus,
  PaymentPlanStatus,
  PaymentPlanType,
  PaymentStatus,
  PaymentType,
  UserRole,
} from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { PaymentPlansService } from './payment-plans.service';

jest.setTimeout(60000);

// The spec shares db_creditos_test with other integration suites that run in
// parallel (npm test), so it never truncates: every email, phone, identity
// document, catalog name and method name carries a per-run suffix
// (pid + timestamp), matching the unique-data convention of the other suites.
const RUN_SUFFIX = `${process.pid}${Date.now()}`;
let uniqueCounter = 0;

function emailFor(localPart: string): string {
  return `${localPart}.${RUN_SUFFIX}@example.com`;
}

function uniqueDocument(): string {
  return `DOC${Date.now().toString(36)}${uniqueCounter++}`;
}

interface IdRow {
  id: string;
}

interface PlanRow {
  id: string;
  type: string;
  down_payment: string;
  financed_amount: string;
  monthly_interest_rate: string;
  installment_count: number;
  start_date: string;
  outstanding_balance: string;
  status: string;
}

interface InstallmentRow {
  installment_number: number;
  principal_amount: string;
  interest_amount: string;
  total_amount: string;
  paid_amount: string;
  due_date: string;
  status: string;
}

interface PaymentRow {
  amount: string;
  type: string;
  status: string;
  recorded_by_user_id: string;
  payment_method_id: string;
  installment_id: string | null;
  amortization_mode: string | null;
}

interface AuditRow {
  user_id: string | null;
  action: string;
  table_name: string;
  record_id: string;
  new_data: {
    financedAmount?: string;
    installments?: {
      installmentNumber: number;
      principalAmount: string;
      interestAmount: string;
      totalAmount: string;
      dueDate: string;
    }[];
  } | null;
}

describe('payment plans API (design sections 5.8, 5.9, 8.1-T1 and 11)', () => {
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
      emailFor(`office.plans.${uniqueCounter++}`),
      'Office Plans',
      UserRole.OFFICE,
    );
    return { id, token: await tokenForUserId(id) };
  }

  async function adminToken(): Promise<string> {
    const adminId = await insertUserRaw(
      emailFor(`admin.plans.${uniqueCounter++}`),
      'Admin Plans',
      UserRole.ADMIN,
    );
    return tokenForUserId(adminId);
  }

  async function patientUser(): Promise<{ id: string; token: string }> {
    const id = await insertUserRaw(
      emailFor(`patient.plans.${uniqueCounter++}`),
      'Patient Plans',
      UserRole.PATIENT,
    );
    return { id, token: await tokenForUserId(id) };
  }

  // userId optional: NULL = hybrid model (no web account), provided = the
  // patient owns a user account (needed for the own-plan read scenarios).
  async function createPatientRaw(userId: string | null = null): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (user_id, identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        userId,
        uniqueDocument(),
        'Maria',
        'Gomez',
        `+51${RUN_SUFFIX}${uniqueCounter++}`,
      ],
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

  async function createSurgery(
    token: string,
    patientId: string,
    catalogId: string,
    totalCost: string,
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/surgeries')
      .set('Authorization', `Bearer ${token}`)
      .send({
        patientId,
        surgeryCatalogId: catalogId,
        scheduledDate: '2026-08-15',
        totalCost,
      });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  function createPlan(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/payment-plans')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function getPlan(token: string, id: string) {
    return request(app.getHttpServer())
      .get(`/api/payment-plans/${id}`)
      .set('Authorization', `Bearer ${token}`);
  }

  function getInstallments(token: string, id: string) {
    return request(app.getHttpServer())
      .get(`/api/payment-plans/${id}/installments`)
      .set('Authorization', `Bearer ${token}`);
  }

  async function createDisabledPaymentMethod(token: string): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/api/payment-methods')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: `Method-${RUN_SUFFIX}-${uniqueCounter++}`, isEnabled: true });
    expect(created.status).toBe(201);
    const disabled = await request(app.getHttpServer())
      .patch(`/api/payment-methods/${created.body.id as string}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isEnabled: false });
    expect(disabled.status).toBe(200);
    return created.body.id as string;
  }

  async function cashMethodId(): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `SELECT id FROM payment_methods WHERE name = 'cash'`,
    );
    return rows[0].id;
  }

  async function planRows(surgeryId: string): Promise<PlanRow[]> {
    return dataSource.query(
      `SELECT id, type, down_payment::text AS down_payment,
              financed_amount::text AS financed_amount,
              monthly_interest_rate::text AS monthly_interest_rate,
              installment_count, start_date::text AS start_date,
              outstanding_balance::text AS outstanding_balance, status
       FROM payment_plans WHERE surgery_id = $1`,
      [surgeryId],
    );
  }

  async function installmentRows(planId: string): Promise<InstallmentRow[]> {
    return dataSource.query(
      `SELECT installment_number, principal_amount::text AS principal_amount,
              interest_amount::text AS interest_amount,
              total_amount::text AS total_amount,
              paid_amount::text AS paid_amount,
              due_date::text AS due_date, status
       FROM installments WHERE payment_plan_id = $1
       ORDER BY installment_number`,
      [planId],
    );
  }

  async function installmentSums(planId: string): Promise<{
    principal: string;
    interest: string;
    total: string;
  }> {
    const rows: { principal: string; interest: string; total: string }[] =
      await dataSource.query(
        `SELECT SUM(principal_amount)::text AS principal,
                SUM(interest_amount)::text AS interest,
                SUM(total_amount)::text AS total
         FROM installments WHERE payment_plan_id = $1`,
        [planId],
      );
    return rows[0];
  }

  async function paymentRows(planId: string): Promise<PaymentRow[]> {
    return dataSource.query(
      `SELECT amount::text AS amount, type, status, recorded_by_user_id,
              payment_method_id, installment_id, amortization_mode
       FROM payments WHERE payment_plan_id = $1`,
      [planId],
    );
  }

  async function auditRowsForPlan(planId: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT user_id, action, table_name, record_id, new_data
       FROM audit_logs WHERE record_id = $1 AND action = 'payment_plan.created'
       ORDER BY created_at`,
      [planId],
    );
  }

  async function countPlansForSurgery(surgeryId: string): Promise<number> {
    return (await planRows(surgeryId)).length;
  }

  describe('credit plan creation (T1: pinned French schedule)', () => {
    it('creates a credit plan whose schedule matches the pinned reference values exactly', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '10000.00',
      );

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        monthlyInterestRate: '2.00',
        installmentCount: 10,
        startDate: '2026-01-01',
      });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe(PaymentPlanType.CREDIT);
      expect(response.body.downPayment).toBe('0.00');
      expect(response.body.financedAmount).toBe('10000.00');
      expect(response.body.monthlyInterestRate).toBe('2.00');
      expect(response.body.installmentCount).toBe(10);
      expect(response.body.startDate).toBe('2026-01-01');
      expect(response.body.outstandingBalance).toBe('10000.00');
      expect(response.body.status).toBe(PaymentPlanStatus.ACTIVE);

      const plans = await planRows(surgeryId);
      expect(plans).toHaveLength(1);
      expect(plans[0].financed_amount).toBe('10000.00');
      expect(plans[0].outstanding_balance).toBe('10000.00');

      const installments = await installmentRows(plans[0].id);
      expect(installments).toHaveLength(10);
      // Pinned reference schedule (spec "Reference schedule" + design 6.2):
      // A = 1,113.27; lines 1-9 at 1,113.27, line 10 absorbs the remainder.
      expect(installments[0]).toMatchObject({
        installment_number: 1,
        principal_amount: '913.27',
        interest_amount: '200.00',
        total_amount: '1113.27',
        paid_amount: '0.00',
        due_date: '2026-02-01',
        status: InstallmentStatus.PENDING,
      });
      expect(installments[1]).toMatchObject({
        installment_number: 2,
        principal_amount: '931.54',
        interest_amount: '181.73',
        total_amount: '1113.27',
      });
      expect(installments[2]).toMatchObject({
        installment_number: 3,
        principal_amount: '950.17',
        interest_amount: '163.10',
        total_amount: '1113.27',
      });
      // Last line absorbs the rounding remainder (spec "Rounding remainder
      // absorbed by the last installment"): total 1,113.22, never 1,113.27.
      expect(installments[9]).toMatchObject({
        installment_number: 10,
        principal_amount: '1091.39',
        interest_amount: '21.83',
        total_amount: '1113.22',
        due_date: '2026-11-01',
      });

      const sums = await installmentSums(plans[0].id);
      expect(sums.principal).toBe('10000.00');
      expect(sums.interest).toBe('1132.65');
      expect(sums.total).toBe('11132.65');
    });

    it('clamps end-of-month due dates to the target month last day', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '3000.00',
      );

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 3,
        startDate: '2026-01-31',
      });

      expect(response.status).toBe(201);
      const plans = await planRows(surgeryId);
      const installments = await installmentRows(plans[0].id);
      expect(installments.map((row) => row.due_date)).toEqual([
        '2026-02-28',
        '2026-03-31',
        '2026-04-30',
      ]);
    });

    it('requires installmentCount for credit plans (400)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '5000.00',
      );

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
      });

      expect(response.status).toBe(400);
      expect(await countPlansForSurgery(surgeryId)).toBe(0);
    });

    it('rejects an invalid plan type with 400', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '5000.00',
      );

      const response = await createPlan(office.token, {
        surgeryId,
        type: 'cash',
        installmentCount: 5,
      });

      expect(response.status).toBe(400);
      expect(await countPlansForSurgery(surgeryId)).toBe(0);
    });

    it('rejects a down payment equal to or above the surgery total cost (400)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '5000.00',
      );

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        downPayment: '5000.00',
        installmentCount: 5,
      });

      expect(response.status).toBe(400);
      expect(await countPlansForSurgery(surgeryId)).toBe(0);
    });

    it('returns 404 when the surgery does not exist', async () => {
      const office = await officeUser();

      const response = await createPlan(office.token, {
        surgeryId: '00000000-0000-4000-8000-000000000000',
        type: PaymentPlanType.CREDIT,
        installmentCount: 5,
      });

      expect(response.status).toBe(404);
      // Real route exists: the 404 comes from the service, not a missing route.
      expect(response.body.message).toBe('Surgery not found');
    });

    it('forbids patient-role users from creating plans (403)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '5000.00',
      );
      const patient = await patientUser();

      const response = await createPlan(patient.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 5,
      });

      expect(response.status).toBe(403);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const response = await request(app.getHttpServer()).post('/api/payment-plans');
      expect(response.status).toBe(401);
    });
  });

  describe('down payment flow (auto-confirmed inside the T1 transaction)', () => {
    it('registers an auto-confirmed down payment and schedules over the financed amount only', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '10000.00',
      );
      const methodId = await cashMethodId();

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        downPayment: '3000.00',
        monthlyInterestRate: '2.00',
        installmentCount: 10,
        startDate: '2026-01-01',
        paymentMethodId: methodId,
      });

      expect(response.status).toBe(201);
      // Spec "Credit plan with down payment": financed = total - down, and
      // the schedule is generated over the financed amount only.
      expect(response.body.financedAmount).toBe('7000.00');
      expect(response.body.downPayment).toBe('3000.00');
      expect(response.body.outstandingBalance).toBe('7000.00');

      const plans = await planRows(surgeryId);
      expect(plans[0].financed_amount).toBe('7000.00');
      expect(plans[0].outstanding_balance).toBe('7000.00');

      const installments = await installmentRows(plans[0].id);
      expect(installments).toHaveLength(10);
      // A = 779.29 for P=7,000 @2% n=10; first line interest = HALF_UP(7000*0.02).
      expect(installments[0]).toMatchObject({
        installment_number: 1,
        principal_amount: '639.29',
        interest_amount: '140.00',
        total_amount: '779.29',
      });
      const sums = await installmentSums(plans[0].id);
      expect(sums.principal).toBe('7000.00');

      const payments = await paymentRows(plans[0].id);
      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        amount: '3000.00',
        type: PaymentType.DOWN_PAYMENT,
        status: PaymentStatus.CONFIRMED,
        recorded_by_user_id: office.id,
        payment_method_id: methodId,
        installment_id: null,
        amortization_mode: null,
      });
    });

    it('requires paymentMethodId when a down payment is provided (400)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '10000.00',
      );

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        downPayment: '1000.00',
        installmentCount: 10,
      });

      expect(response.status).toBe(400);
      expect(await countPlansForSurgery(surgeryId)).toBe(0);
    });

    it('returns 404 for an unknown payment method and rolls back the whole transaction', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '10000.00',
      );

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        downPayment: '1000.00',
        installmentCount: 10,
        paymentMethodId: '00000000-0000-4000-8000-000000000000',
      });

      expect(response.status).toBe(404);
      // Real route exists: the 404 comes from the service, not a missing route.
      expect(response.body.message).toBe('Payment method not found');
      // T1 rollback: no plan, no installments, no payment, no audit residue.
      expect(await countPlansForSurgery(surgeryId)).toBe(0);
      const plans = await planRows(surgeryId);
      expect(plans).toHaveLength(0);
      expect(
        await dataSource.query(
          `SELECT COUNT(*)::text AS count FROM payments WHERE recorded_by_user_id = $1`,
          [office.id],
        ),
      ).toEqual([{ count: '0' }]);
    });

    it('rejects a disabled payment method with 409 and rolls back the whole transaction', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '10000.00',
      );
      const disabledMethodId = await createDisabledPaymentMethod(office.token);

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        downPayment: '1000.00',
        installmentCount: 10,
        paymentMethodId: disabledMethodId,
      });

      expect(response.status).toBe(409);
      // The method check runs after the plan and installment rows are written
      // inside the transaction, so this proves the whole T1 tx rolled back:
      // no plan, no installments, no payment, no audit entry for this actor.
      const plans = await planRows(surgeryId);
      expect(plans).toHaveLength(0);
      expect(
        await dataSource.query(
          `SELECT COUNT(*)::text AS count FROM audit_logs
           WHERE action = 'payment_plan.created' AND user_id = $1`,
          [office.id],
        ),
      ).toEqual([{ count: '0' }]);
    });
  });

  describe('upfront plans (installment_count forced to 1, zero interest)', () => {
    it('creates an upfront plan with a single zero-interest installment equal to the financed amount', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '7000.00',
      );

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.UPFRONT,
      });

      expect(response.status).toBe(201);
      expect(response.body.type).toBe(PaymentPlanType.UPFRONT);
      expect(response.body.financedAmount).toBe('7000.00');
      expect(response.body.monthlyInterestRate).toBe('0.00');
      expect(response.body.installmentCount).toBe(1);
      expect(response.body.outstandingBalance).toBe('7000.00');

      const plans = await planRows(surgeryId);
      const installments = await installmentRows(plans[0].id);
      expect(installments).toHaveLength(1);
      // Spec "Upfront plan schedule": P=7,000.00, i=0, n=1 -> 7,000.00 / 0.00.
      expect(installments[0]).toMatchObject({
        installment_number: 1,
        principal_amount: '7000.00',
        interest_amount: '0.00',
        total_amount: '7000.00',
      });
      expect(await paymentRows(plans[0].id)).toHaveLength(0);
    });

    it('registers a down payment for an upfront plan and finances only the remainder', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '7000.00',
      );
      const methodId = await cashMethodId();

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.UPFRONT,
        downPayment: '3000.00',
        paymentMethodId: methodId,
      });

      expect(response.status).toBe(201);
      expect(response.body.financedAmount).toBe('4000.00');
      expect(response.body.installmentCount).toBe(1);

      const plans = await planRows(surgeryId);
      const installments = await installmentRows(plans[0].id);
      expect(installments).toHaveLength(1);
      expect(installments[0]).toMatchObject({
        principal_amount: '4000.00',
        interest_amount: '0.00',
        total_amount: '4000.00',
      });
      const payments = await paymentRows(plans[0].id);
      expect(payments).toHaveLength(1);
      expect(payments[0].amount).toBe('3000.00');
      expect(payments[0].status).toBe(PaymentStatus.CONFIRMED);
    });
  });

  describe('one plan per surgery (UNIQUE surgery_id)', () => {
    it('rejects a second plan for the same surgery with 409 and persists nothing', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '10000.00',
      );

      const first = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 10,
        startDate: '2026-01-01',
      });
      expect(first.status).toBe(201);

      const second = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.UPFRONT,
      });

      expect(second.status).toBe(409);
      const plans = await planRows(surgeryId);
      expect(plans).toHaveLength(1);
      expect(await installmentRows(plans[0].id)).toHaveLength(10);
      expect(await paymentRows(plans[0].id)).toHaveLength(0);
      expect(await auditRowsForPlan(plans[0].id)).toHaveLength(1);
    });
  });

  describe('audit logging (payment_plan.created inside the T1 transaction)', () => {
    it('writes exactly one audit entry with the generated schedule in new_data', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '10000.00',
      );

      const response = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 10,
        startDate: '2026-01-01',
      });

      expect(response.status).toBe(201);
      const plans = await planRows(surgeryId);
      const audit = await auditRowsForPlan(plans[0].id);
      expect(audit).toHaveLength(1);
      expect(audit[0].user_id).toBe(office.id);
      expect(audit[0].action).toBe('payment_plan.created');
      expect(audit[0].table_name).toBe('payment_plans');
      expect(audit[0].record_id).toBe(plans[0].id);
      expect(audit[0].new_data?.financedAmount).toBe('10000.00');
      expect(audit[0].new_data?.installments).toHaveLength(10);
      expect(audit[0].new_data?.installments?.[0]).toMatchObject({
        installmentNumber: 1,
        principalAmount: '913.27',
        interestAmount: '200.00',
        totalAmount: '1113.27',
        dueDate: '2026-02-01',
      });
    });
  });

  describe('plan reads (office/admin any plan, patient own plan only)', () => {
    it('returns the plan detail for an office user', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '6000.00',
      );
      const created = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 6,
      });
      expect(created.status).toBe(201);

      const response = await getPlan(office.token, created.body.id as string);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.id);
      expect(response.body.financedAmount).toBe('6000.00');
      expect(response.body.status).toBe(PaymentPlanStatus.ACTIVE);
    });

    it('returns the plan detail for an admin user', async () => {
      const office = await officeUser();
      const admin = await adminToken();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '6000.00',
      );
      const created = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 6,
      });
      expect(created.status).toBe(201);

      const response = await getPlan(admin, created.body.id as string);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.id);
    });

    it('lets a patient read their own plan', async () => {
      const office = await officeUser();
      const patient = await patientUser();
      const patientId = await createPatientRaw(patient.id);
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '6000.00',
      );
      const created = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 6,
      });
      expect(created.status).toBe(201);

      const response = await getPlan(patient.token, created.body.id as string);

      expect(response.status).toBe(200);
      expect(response.body.id).toBe(created.body.id);
    });

    it('forbids a patient from reading another patient plan (403)', async () => {
      const office = await officeUser();
      const ownerPatient = await patientUser();
      const otherPatient = await patientUser();
      const ownerPatientId = await createPatientRaw(ownerPatient.id);
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        ownerPatientId,
        catalog.id,
        '6000.00',
      );
      const created = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 6,
      });
      expect(created.status).toBe(201);

      const response = await getPlan(otherPatient.token, created.body.id as string);

      expect(response.status).toBe(403);
    });

    it('returns 404 for an unknown plan id', async () => {
      const office = await officeUser();

      const response = await getPlan(
        office.token,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(response.status).toBe(404);
      // Real route exists: the 404 comes from the service, not a missing route.
      expect(response.body.message).toBe('Payment plan not found');
    });
  });

  describe('installments read with derived overdue flag (read-only)', () => {
    it('marks past-due pending installments as overdue and never writes', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '3000.00',
      );
      const created = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 3,
        startDate: '2026-05-01',
      });
      expect(created.status).toBe(201);
      const plans = await planRows(surgeryId);
      const planId = plans[0].id;
      // Pin the due dates deterministically (the suite shares the DB and the
      // clock moves): installment 1 stays pending but past due; installment 2
      // is paid with a past due date (never overdue); installment 3 stays
      // pending with a far-future due date.
      await dataSource.query(
        `UPDATE installments SET due_date = '2020-01-01' WHERE payment_plan_id = $1 AND installment_number = 1`,
        [planId],
      );
      await dataSource.query(
        `UPDATE installments SET due_date = '2020-01-01', status = 'paid', paid_amount = total_amount
         WHERE payment_plan_id = $1 AND installment_number = 2`,
        [planId],
      );
      await dataSource.query(
        `UPDATE installments SET due_date = '2999-01-01' WHERE payment_plan_id = $1 AND installment_number = 3`,
        [planId],
      );

      const response = await getInstallments(office.token, planId);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(3);
      expect(response.body[0]).toMatchObject({
        installmentNumber: 1,
        overdue: true,
        status: InstallmentStatus.PENDING,
      });
      expect(response.body[1]).toMatchObject({
        installmentNumber: 2,
        overdue: false,
        status: InstallmentStatus.PAID,
      });
      expect(response.body[2]).toMatchObject({
        installmentNumber: 3,
        overdue: false,
        status: InstallmentStatus.PENDING,
      });
      // The read never writes: plan status stays active, rows unchanged.
      const plansAfter = await planRows(surgeryId);
      expect(plansAfter[0].status).toBe(PaymentPlanStatus.ACTIVE);
      const rowsAfter = await installmentRows(planId);
      expect(rowsAfter[0].due_date).toBe('2020-01-01');
      expect(rowsAfter[0].status).toBe(InstallmentStatus.PENDING);
    });

    it('returns installments ordered by number for the plan owner', async () => {
      const office = await officeUser();
      const patient = await patientUser();
      const patientId = await createPatientRaw(patient.id);
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '6000.00',
      );
      const created = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 6,
        startDate: '2026-01-01',
      });
      expect(created.status).toBe(201);

      const response = await getInstallments(patient.token, created.body.id as string);

      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(6);
      expect(response.body.map((row: { installmentNumber: number }) => row.installmentNumber)).toEqual(
        [1, 2, 3, 4, 5, 6],
      );
      expect(response.body[0].totalAmount).toBe('1071.15');
    });

    it('forbids a patient from reading another patient installments (403)', async () => {
      const office = await officeUser();
      const ownerPatient = await patientUser();
      const otherPatient = await patientUser();
      const ownerPatientId = await createPatientRaw(ownerPatient.id);
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        ownerPatientId,
        catalog.id,
        '6000.00',
      );
      const created = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 6,
      });
      expect(created.status).toBe(201);

      const response = await getInstallments(
        otherPatient.token,
        created.body.id as string,
      );

      expect(response.status).toBe(403);
    });
  });

  describe('patient debt summary (design section 10 — service-only read)', () => {
    let paymentPlansService: PaymentPlansService;

    beforeAll(() => {
      paymentPlansService = app.get(PaymentPlansService);
    });

    async function installmentIdFor(
      planId: string,
      number: number,
    ): Promise<string> {
      const rows: IdRow[] = await dataSource.query(
        `SELECT id FROM installments
         WHERE payment_plan_id = $1 AND installment_number = $2`,
        [planId, number],
      );
      return rows[0].id;
    }

    // Spec scenario "Hybrid patient summary": the schedule is built through
    // the real FinancingEngine (10 x 1113.27 lines), the delinquent state and
    // the overdue amount come from a partial office payment (500.00 on
    // installment 1 -> PARTIAL, overdue 613.27), and the deterministic pins
    // (same direct-UPDATE convention as the overdue test above) fix the
    // scenario dates and the tracked outstanding_balance column — which the
    // read NEVER recomputes (design D4).
    async function hybridPatientWithPinnedDebt(): Promise<{
      patientId: string;
      planId: string;
    }> {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '10000.00',
      );
      const created = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        monthlyInterestRate: '2.00',
        installmentCount: 10,
        startDate: '2026-01-01',
      });
      expect(created.status).toBe(201);
      const plans = await planRows(surgeryId);
      const planId = plans[0].id;

      const methodId = await cashMethodId();
      const payment = await request(app.getHttpServer())
        .post('/api/payments')
        .set('Authorization', `Bearer ${office.token}`)
        .send({
          paymentPlanId: planId,
          installmentId: await installmentIdFor(planId, 1),
          paymentMethodId: methodId,
          amount: '500.00',
          type: PaymentType.INSTALLMENT_PAYMENT,
        });
      expect(payment.status).toBe(201);
      expect(payment.body.status).toBe(PaymentStatus.CONFIRMED);

      // Pin the scenario state deterministically (the suite shares
      // db_creditos_test and the clock moves): installment 1 stays PARTIAL
      // and overdue; installment 2 becomes the next due (spec pin
      // 2026-08-05); the rest move far-future so only installment 1 is
      // overdue.
      await dataSource.query(
        `UPDATE installments SET due_date = '2020-01-01'
         WHERE payment_plan_id = $1 AND installment_number = 1`,
        [planId],
      );
      await dataSource.query(
        `UPDATE installments SET due_date = '2026-08-05'
         WHERE payment_plan_id = $1 AND installment_number = 2`,
        [planId],
      );
      await dataSource.query(
        `UPDATE installments SET due_date = '2999-01-01'
         WHERE payment_plan_id = $1 AND installment_number >= 3`,
        [planId],
      );
      // outstanding_balance is the platform's tracked column (design D4) —
      // pin the scenario value 8155.19, the read must return it untouched.
      await dataSource.query(
        `UPDATE payment_plans SET outstanding_balance = '8155.19' WHERE id = $1`,
        [planId],
      );
      return { patientId, planId };
    }

    it('returns the hybrid patient summary with pinned values 8155.19 / 1113.27 / 2026-08-05 / 613.27', async () => {
      const { patientId } = await hybridPatientWithPinnedDebt();

      const summary = await paymentPlansService.getPatientDebtSummary(
        patientId,
      );

      expect(summary).toEqual({
        outstandingBalance: '8155.19',
        nextDueInstallment: {
          installmentNumber: 2,
          totalAmount: '1113.27',
          dueDate: '2026-08-05',
        },
        overdueTotal: '613.27',
      });
    });

    it('returns the zero summary for a patient without a payment plan', async () => {
      const patientId = await createPatientRaw();

      const summary = await paymentPlansService.getPatientDebtSummary(
        patientId,
      );

      expect(summary).toEqual({
        outstandingBalance: '0.00',
        nextDueInstallment: null,
        overdueTotal: '0.00',
      });
    });

    it('returns a null next due with the full overdue total when every unpaid installment is past due', async () => {
      const { patientId, planId } = await hybridPatientWithPinnedDebt();
      // Move every installment into the past: no future unpaid line remains,
      // so nextDueInstallment is null while the overdue total still accrues
      // (613.27 partial #1 + 8 x 1113.27 lines #2..#9 + 1113.22 line #10 —
      // the last line absorbs the rounding remainder = 10,632.65).
      await dataSource.query(
        `UPDATE installments SET due_date = '2020-01-01'
         WHERE payment_plan_id = $1`,
        [planId],
      );

      const summary = await paymentPlansService.getPatientDebtSummary(
        patientId,
      );

      expect(summary).toEqual({
        outstandingBalance: '8155.19',
        nextDueInstallment: null,
        overdueTotal: '10632.65',
      });
    });

    it('exposes no HTTP surface for the summary while patient own-record reads keep working', async () => {
      const office = await officeUser();
      const patient = await patientUser();
      const patientId = await createPatientRaw(patient.id);
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '6000.00',
      );
      const created = await createPlan(office.token, {
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount: 6,
      });
      expect(created.status).toBe(201);

      // Design D4: the read is not exposed as a route of any kind, so any
      // role gets 404 — there is nothing to authorize (no 403 surface).
      const route = `/api/payment-plans/${created.body.id as string}/summary`;
      const patientAttempt = await request(app.getHttpServer())
        .get(route)
        .set('Authorization', `Bearer ${patient.token}`);
      expect(patientAttempt.status).toBe(404);
      const officeAttempt = await request(app.getHttpServer())
        .get(route)
        .set('Authorization', `Bearer ${office.token}`);
      expect(officeAttempt.status).toBe(404);

      // Existing user-gated reads stay unchanged: the patient still reads
      // their own plan.
      const ownPlan = await getPlan(patient.token, created.body.id as string);
      expect(ownPlan.status).toBe(200);
      expect(ownPlan.body.id).toBe(created.body.id);
    });
  });
});
