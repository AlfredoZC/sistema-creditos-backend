import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import {
  AmortizationMode,
  InstallmentStatus,
  PaymentPlanStatus,
  PaymentPlanType,
  PaymentStatus,
  PaymentType,
  UserRole,
} from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

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
  outstanding_balance: string;
  status: string;
}

interface InstallmentRow {
  id: string;
  installment_number: number;
  principal_amount: string;
  interest_amount: string;
  total_amount: string;
  paid_amount: string;
  due_date: string;
  status: string;
}

interface PaymentRow {
  id: string;
  amount: string;
  type: string;
  status: string;
  recorded_by_user_id: string;
  patient_user_id: string | null;
  installment_id: string | null;
  amortization_mode: string | null;
}

interface AuditRow {
  user_id: string | null;
  action: string;
  table_name: string;
  record_id: string;
  previous_data: {
    status?: string;
    outstandingBalance?: string;
    installments?: unknown[];
  } | null;
  new_data: {
    status?: string;
    outstandingBalance?: string;
    installments?: {
      id: string;
      installmentNumber: number;
      principalAmount: string;
      interestAmount: string;
      totalAmount: string;
      status: string;
    }[];
  } | null;
}

describe('payments API (design sections 5.11, 8.1-T2..T5 and 11)', () => {
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
      emailFor(`office.pay.${uniqueCounter++}`),
      'Office Pay',
      UserRole.OFFICE,
    );
    return { id, token: await tokenForUserId(id) };
  }

  async function adminUser(): Promise<{ id: string; token: string }> {
    const id = await insertUserRaw(
      emailFor(`admin.pay.${uniqueCounter++}`),
      'Admin Pay',
      UserRole.ADMIN,
    );
    return { id, token: await tokenForUserId(id) };
  }

  async function patientUser(): Promise<{ id: string; token: string }> {
    const id = await insertUserRaw(
      emailFor(`patient.pay.${uniqueCounter++}`),
      'Patient Pay',
      UserRole.PATIENT,
    );
    return { id, token: await tokenForUserId(id) };
  }

  // userId optional: NULL = hybrid model (no web account), provided = the
  // patient owns a user account (needed for own-plan payment scenarios).
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

  async function createCreditPlan(
    officeToken: string,
    totalCost: string,
    installmentCount: number,
    options: {
      downPayment?: string;
      monthlyInterestRate?: string;
      startDate?: string;
    } = {},
  ): Promise<{ planId: string; surgeryId: string }> {
    const patientId = await createPatientRaw();
    const catalog = await createCatalogEntry(officeToken);
    const surgeryId = await createSurgery(officeToken, patientId, catalog.id, totalCost);
    const body: Record<string, unknown> = {
      surgeryId,
      type: PaymentPlanType.CREDIT,
      installmentCount,
      monthlyInterestRate: options.monthlyInterestRate ?? '2.00',
      startDate: options.startDate ?? '2026-01-01',
    };
    if (options.downPayment !== undefined) {
      body.downPayment = options.downPayment;
      body.paymentMethodId = await cashMethodId();
    }
    const response = await request(app.getHttpServer())
      .post('/api/payment-plans')
      .set('Authorization', `Bearer ${officeToken}`)
      .send(body);
    expect(response.status).toBe(201);
    return { planId: response.body.id as string, surgeryId };
  }

  async function createCreditPlanForPatient(
    officeToken: string,
    patientId: string,
    totalCost: string,
    installmentCount: number,
  ): Promise<{ planId: string; surgeryId: string }> {
    const catalog = await createCatalogEntry(officeToken);
    const surgeryId = await createSurgery(officeToken, patientId, catalog.id, totalCost);
    const response = await request(app.getHttpServer())
      .post('/api/payment-plans')
      .set('Authorization', `Bearer ${officeToken}`)
      .send({
        surgeryId,
        type: PaymentPlanType.CREDIT,
        installmentCount,
        monthlyInterestRate: '2.00',
        startDate: '2026-01-01',
      });
    expect(response.status).toBe(201);
    return { planId: response.body.id as string, surgeryId };
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

  async function planRows(planId: string): Promise<PlanRow[]> {
    return dataSource.query(
      `SELECT id, type, down_payment::text AS down_payment,
              financed_amount::text AS financed_amount,
              monthly_interest_rate::text AS monthly_interest_rate,
              installment_count, outstanding_balance::text AS outstanding_balance,
              status
       FROM payment_plans WHERE id = $1`,
      [planId],
    );
  }

  async function installmentRows(planId: string): Promise<InstallmentRow[]> {
    return dataSource.query(
      `SELECT id, installment_number, principal_amount::text AS principal_amount,
              interest_amount::text AS interest_amount,
              total_amount::text AS total_amount,
              paid_amount::text AS paid_amount,
              due_date::text AS due_date, status
       FROM installments WHERE payment_plan_id = $1
       ORDER BY installment_number`,
      [planId],
    );
  }

  async function installmentIdFor(planId: string, number: number): Promise<string> {
    const rows = await installmentRows(planId);
    const match = rows.find((row) => row.installment_number === number);
    if (!match) throw new Error(`installment ${number} not found`);
    return match.id;
  }

  async function paymentRows(planId: string): Promise<PaymentRow[]> {
    return dataSource.query(
      `SELECT id, amount::text AS amount, type, status, recorded_by_user_id,
              patient_user_id, installment_id, amortization_mode
       FROM payments WHERE payment_plan_id = $1
       ORDER BY paid_at`,
      [planId],
    );
  }

  async function auditRowsForPayment(paymentId: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT user_id, action, table_name, record_id, previous_data, new_data
       FROM audit_logs WHERE record_id = $1
       ORDER BY created_at`,
      [paymentId],
    );
  }

  async function auditRowsForPlan(planId: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT user_id, action, table_name, record_id, previous_data, new_data
       FROM audit_logs WHERE record_id = $1
       ORDER BY created_at`,
      [planId],
    );
  }

  async function recalcAuditCount(actorId: string): Promise<number> {
    const rows: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*)::text AS count FROM audit_logs
       WHERE action = 'payment_plan.recalculated' AND user_id = $1`,
      [actorId],
    );
    return Number(rows[0].count);
  }

  function registerPayment(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function confirmPayment(token: string, id: string) {
    return request(app.getHttpServer())
      .post(`/api/payments/${id}/confirm`)
      .set('Authorization', `Bearer ${token}`);
  }

  function rejectPayment(token: string, id: string) {
    return request(app.getHttpServer())
      .post(`/api/payments/${id}/reject`)
      .set('Authorization', `Bearer ${token}`);
  }

  function listPayments(token: string) {
    return request(app.getHttpServer())
      .get('/api/payments')
      .set('Authorization', `Bearer ${token}`);
  }

  describe('registration (T2: office auto-confirms, T3: patient upload stays pending)', () => {
    it('auto-confirms an office installment payment and applies its effects in one transaction', async () => {
      const office = await officeUser();
      const { planId } = await createCreditPlan(office.token, '10000.00', 10);
      const installment1 = await installmentIdFor(planId, 1);
      const methodId = await cashMethodId();

      const response = await registerPayment(office.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: methodId,
        amount: '1113.27',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe(PaymentStatus.CONFIRMED);
      expect(response.body.type).toBe(PaymentType.INSTALLMENT_PAYMENT);
      expect(response.body.amount).toBe('1113.27');
      expect(response.body.patientUserId).toBeNull();
      expect(response.body.recordedByUserId).toBe(office.id);

      // Spec "Office counter payment auto-confirms": the effects are applied
      // in the same transaction — the installment is fully paid (credit =
      // principal 913.27) and the outstanding balance drops to 9,086.73. The
      // remaining pending installments (due 2026-02-01 onward, before today)
      // make the plan delinquent by the design 8.2 evaluation.
      const plan = (await planRows(planId))[0];
      expect(plan.outstanding_balance).toBe('9086.73');
      expect(plan.status).toBe(PaymentPlanStatus.DELINQUENT);

      const installments = await installmentRows(planId);
      expect(installments[0]).toMatchObject({
        installment_number: 1,
        paid_amount: '1113.27',
        status: InstallmentStatus.PAID,
      });
      expect(installments[1].paid_amount).toBe('0.00');
      expect(installments[1].status).toBe(InstallmentStatus.PENDING);

      // Exactly one audit entry, in the same transaction, actor attributed.
      const audits = await auditRowsForPayment(response.body.id);
      expect(audits).toHaveLength(1);
      expect(audits[0].action).toBe('payment.confirmed');
      expect(audits[0].user_id).toBe(office.id);
      expect(audits[0].table_name).toBe('payments');
      expect(audits[0].record_id).toBe(response.body.id);
      expect(audits[0].previous_data?.status).toBe(PaymentStatus.PENDING_CONFIRMATION);
      expect(audits[0].new_data?.status).toBe(PaymentStatus.CONFIRMED);
      expect(audits[0].new_data?.outstandingBalance).toBe('9086.73');
      // Recalculation is NEVER triggered for a plain installment payment.
      expect(await recalcAuditCount(office.id)).toBe(0);
    });

    it('marks the installment partial when an office payment does not cover it', async () => {
      const office = await officeUser();
      // Far-future due dates keep every remaining installment pending but not
      // overdue, so the plan evaluation yields 'active' after the payment.
      const { planId } = await createCreditPlan(
        office.token,
        '10000.00',
        10,
        { startDate: '2999-01-01' },
      );
      const installment1 = await installmentIdFor(planId, 1);

      const response = await registerPayment(office.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: await cashMethodId(),
        amount: '500.00',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });

      expect(response.status).toBe(201);
      expect(response.body.status).toBe(PaymentStatus.CONFIRMED);

      // Spec "Partial payment": paid_amount accumulates and the status moves
      // pending -> partial. creditPrincipal(500) = HALF_UP(913.27*500/1113.27)
      // = 410.17, so the balance drops by 410.17 only.
      const installments = await installmentRows(planId);
      expect(installments[0]).toMatchObject({
        paid_amount: '500.00',
        status: InstallmentStatus.PARTIAL,
      });
      const plan = (await planRows(planId))[0];
      expect(plan.outstanding_balance).toBe('9589.83');
      expect(plan.status).toBe(PaymentPlanStatus.ACTIVE);
    });

    it('keeps a patient receipt upload pending with no effects and no audit', async () => {
      const office = await officeUser();
      const patient = await patientUser();
      const patientId = await createPatientRaw(patient.id);
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '10000.00',
      );
      const created = await request(app.getHttpServer())
        .post('/api/payment-plans')
        .set('Authorization', `Bearer ${office.token}`)
        .send({
          surgeryId,
          type: PaymentPlanType.CREDIT,
          installmentCount: 10,
          monthlyInterestRate: '2.00',
          startDate: '2026-01-01',
        });
      expect(created.status).toBe(201);
      const planId = created.body.id as string;
      const installment1 = await installmentIdFor(planId, 1);

      const response = await registerPayment(patient.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: await cashMethodId(),
        amount: '1113.27',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });

      // Spec "Patient receipt upload stays pending": the row is stored
      // pending_confirmation with the patient as both patient and recorder.
      expect(response.status).toBe(201);
      expect(response.body.status).toBe(PaymentStatus.PENDING_CONFIRMATION);
      expect(response.body.patientUserId).toBe(patient.id);
      expect(response.body.recordedByUserId).toBe(patient.id);

      // No balance, installment or schedule effect occurs...
      const plan = (await planRows(planId))[0];
      expect(plan.outstanding_balance).toBe('10000.00');
      const installments = await installmentRows(planId);
      expect(installments[0].paid_amount).toBe('0.00');
      expect(installments[0].status).toBe(InstallmentStatus.PENDING);
      // ...and no audit entry at all (T3 registers without audit).
      expect(await auditRowsForPayment(response.body.id)).toHaveLength(0);
      expect(await recalcAuditCount(patient.id)).toBe(0);
    });

    it('rejects a disabled payment method with 409 and rolls back the whole registration', async () => {
      const office = await officeUser();
      const { planId } = await createCreditPlan(office.token, '10000.00', 10);
      const installment1 = await installmentIdFor(planId, 1);
      const disabledMethodId = await createDisabledPaymentMethod(office.token);

      const response = await registerPayment(office.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: disabledMethodId,
        amount: '1113.27',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });

      // Spec "Disabled method rejected": 409 Conflict, nothing persisted.
      expect(response.status).toBe(409);
      expect(response.body.message).toBe('Payment method is disabled');
      expect(await paymentRows(planId)).toHaveLength(0);
      const plan = (await planRows(planId))[0];
      expect(plan.outstanding_balance).toBe('10000.00');
    });

    it('returns 404 for an unknown payment method', async () => {
      const office = await officeUser();
      const { planId } = await createCreditPlan(office.token, '10000.00', 10);
      const installment1 = await installmentIdFor(planId, 1);

      const response = await registerPayment(office.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: '00000000-0000-4000-8000-000000000000',
        amount: '1113.27',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });

      expect(response.status).toBe(404);
      expect(response.body.message).toBe('Payment method not found');
      expect(await paymentRows(planId)).toHaveLength(0);
    });

    it('returns 404 for an unknown payment plan', async () => {
      const office = await officeUser();

      const response = await registerPayment(office.token, {
        paymentPlanId: '00000000-0000-4000-8000-000000000000',
        installmentId: '00000000-0000-4000-8000-000000000001',
        paymentMethodId: await cashMethodId(),
        amount: '1113.27',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });

      expect(response.status).toBe(404);
      // Real route exists: the 404 comes from the service, not a missing route.
      expect(response.body.message).toBe('Payment plan not found');
    });

    it('rejects type integrity violations with 400 and persists nothing', async () => {
      const office = await officeUser();
      const { planId } = await createCreditPlan(office.token, '10000.00', 10);
      const installment1 = await installmentIdFor(planId, 1);
      const methodId = await cashMethodId();
      const base = {
        paymentPlanId: planId,
        paymentMethodId: methodId,
        amount: '100.00',
      };

      // Spec "Type/constraint violations rejected": amortization with an
      // installment, installment_payment without one, amortization_mode on a
      // non-amortization type, missing mode on an amortization, and a down
      // payment referencing an installment are all 400 with no residue.
      const amortizationWithInstallment = await registerPayment(office.token, {
        ...base,
        installmentId: installment1,
        type: PaymentType.PRINCIPAL_AMORTIZATION,
        amortizationMode: AmortizationMode.REDUCE_INSTALLMENT,
      });
      expect(amortizationWithInstallment.status).toBe(400);

      const installmentWithoutId = await registerPayment(office.token, {
        ...base,
        type: PaymentType.INSTALLMENT_PAYMENT,
      });
      expect(installmentWithoutId.status).toBe(400);

      const modeOnNonAmortization = await registerPayment(office.token, {
        ...base,
        installmentId: installment1,
        type: PaymentType.INSTALLMENT_PAYMENT,
        amortizationMode: AmortizationMode.REDUCE_INSTALLMENT,
      });
      expect(modeOnNonAmortization.status).toBe(400);

      const amortizationWithoutMode = await registerPayment(office.token, {
        ...base,
        type: PaymentType.PRINCIPAL_AMORTIZATION,
      });
      expect(amortizationWithoutMode.status).toBe(400);

      const downPaymentWithInstallment = await registerPayment(office.token, {
        ...base,
        installmentId: installment1,
        type: PaymentType.DOWN_PAYMENT,
      });
      expect(downPaymentWithInstallment.status).toBe(400);

      expect(await paymentRows(planId)).toHaveLength(0);
      const plan = (await planRows(planId))[0];
      expect(plan.outstanding_balance).toBe('10000.00');
    });

    it('rejects non-positive amounts with 400', async () => {
      const office = await officeUser();
      const { planId } = await createCreditPlan(office.token, '10000.00', 10);
      const installment1 = await installmentIdFor(planId, 1);

      const zero = await registerPayment(office.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: await cashMethodId(),
        amount: '0.00',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });
      expect(zero.status).toBe(400);

      const negative = await registerPayment(office.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: await cashMethodId(),
        amount: '-1.00',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });
      expect(negative.status).toBe(400);

      expect(await paymentRows(planId)).toHaveLength(0);
    });

    it('forbids a patient from registering a receipt on another patient plan (403)', async () => {
      const office = await officeUser();
      const ownerPatient = await patientUser();
      const otherPatient = await patientUser();
      const ownerPatientId = await createPatientRaw(ownerPatient.id);
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        ownerPatientId,
        catalog.id,
        '10000.00',
      );
      const created = await request(app.getHttpServer())
        .post('/api/payment-plans')
        .set('Authorization', `Bearer ${office.token}`)
        .send({
          surgeryId,
          type: PaymentPlanType.CREDIT,
          installmentCount: 10,
          monthlyInterestRate: '2.00',
          startDate: '2026-01-01',
        });
      expect(created.status).toBe(201);
      const planId = created.body.id as string;
      const installment1 = await installmentIdFor(planId, 1);

      const response = await registerPayment(otherPatient.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: await cashMethodId(),
        amount: '1113.27',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });

      expect(response.status).toBe(403);
      expect(await paymentRows(planId)).toHaveLength(0);
    });

    it('forbids a patient from registering a down payment (400)', async () => {
      const office = await officeUser();
      const patient = await patientUser();
      const patientId = await createPatientRaw(patient.id);
      const catalog = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalog.id,
        '10000.00',
      );
      const created = await request(app.getHttpServer())
        .post('/api/payment-plans')
        .set('Authorization', `Bearer ${office.token}`)
        .send({
          surgeryId,
          type: PaymentPlanType.CREDIT,
          installmentCount: 10,
          monthlyInterestRate: '2.00',
          startDate: '2026-01-01',
        });
      expect(created.status).toBe(201);
      const planId = created.body.id as string;

      const response = await registerPayment(patient.token, {
        paymentPlanId: planId,
        paymentMethodId: await cashMethodId(),
        amount: '500.00',
        type: PaymentType.DOWN_PAYMENT,
      });

      expect(response.status).toBe(400);
      expect(await paymentRows(planId)).toHaveLength(0);
    });

    it('rejects an office overpayment with 409 (D1) and rolls back the registration', async () => {
      const office = await officeUser();
      const { planId } = await createCreditPlan(office.token, '10000.00', 10);
      const installment1 = await installmentIdFor(planId, 1);

      const response = await registerPayment(office.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: await cashMethodId(),
        amount: '1113.28',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });

      // Design D1: paid_amount + amount would exceed total_amount -> 409.
      expect(response.status).toBe(409);
      expect(response.body.message).toBe(
        "amount exceeds the installment's remaining balance; use a principal_amortization for extra payments",
      );
      expect(await paymentRows(planId)).toHaveLength(0);
      const plan = (await planRows(planId))[0];
      expect(plan.outstanding_balance).toBe('10000.00');
      const installments = await installmentRows(planId);
      expect(installments[0].paid_amount).toBe('0.00');
    });

    it('rejects an office amortization above the outstanding balance with 409 and rolls back', async () => {
      const office = await officeUser();
      const { planId } = await createCreditPlan(office.token, '5000.00', 6);

      const response = await registerPayment(office.token, {
        paymentPlanId: planId,
        paymentMethodId: await cashMethodId(),
        amount: '5500.00',
        type: PaymentType.PRINCIPAL_AMORTIZATION,
        amortizationMode: AmortizationMode.REDUCE_INSTALLMENT,
      });

      expect(response.status).toBe(409);
      expect(response.body.message).toBe('amount exceeds the outstanding balance');
      expect(await paymentRows(planId)).toHaveLength(0);
      const plan = (await planRows(planId))[0];
      expect(plan.outstanding_balance).toBe('5000.00');
    });

    it('returns 404 when the installment belongs to another plan', async () => {
      const office = await officeUser();
      const { planId } = await createCreditPlan(office.token, '10000.00', 10);
      const other = await createCreditPlan(office.token, '5000.00', 6);
      const foreignInstallment = await installmentIdFor(other.planId, 1);

      const response = await registerPayment(office.token, {
        paymentPlanId: planId,
        installmentId: foreignInstallment,
        paymentMethodId: await cashMethodId(),
        amount: '1113.27',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });

      expect(response.status).toBe(404);
      expect(response.body.message).toBe('Installment not found');
      expect(await paymentRows(planId)).toHaveLength(0);
    });

    it('rejects unauthenticated registration with 401', async () => {
      const response = await request(app.getHttpServer()).post('/api/payments');
      expect(response.status).toBe(401);
    });
  });
});
