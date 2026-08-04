import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
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
} from '../src/common/enums';
import { ensureTestDbReady } from '../src/test-utils/setup-test-db';
import { buildTestingApp } from '../src/test-utils/test-app';

jest.setTimeout(60000);

const PASSWORD = 'Abc123';
// Unique per-run suffix: the e2e spec never truncates the shared test database,
// so every email, document, phone, catalog name and method name carries a
// pid + timestamp suffix (same convention as test/auth.e2e-spec.ts).
const RUN_SUFFIX = `${process.pid}-${Date.now()}`;
let uniqueCounter = 0;

interface IdRow {
  id: string;
}

interface PlanRow {
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
  status: string;
}

interface AuditRow {
  user_id: string | null;
  action: string;
  table_name: string;
  record_id: string;
  previous_data: {
    outstandingBalance?: string;
    installments?: { totalAmount: string }[];
    status?: string;
  } | null;
  new_data: {
    outstandingBalance?: string;
    installments?: { totalAmount: string }[];
    status?: string;
    type?: string;
    amount?: string;
    amortizationMode?: string;
  } | null;
}

// Design 7 Option A pinned values: financing 6,155.19 @ 2% n=8 generates a
// schedule at 840.24; amortizing 1,000.00 leaves balance 5,155.19, which
// recalculates to 7 lines at 703.73 plus a final 703.76 that absorbs the
// remainder (sum of totals 5,629.87).
const FINANCED_AMOUNT = '6155.19';
const AMORTIZATION_AMOUNT = '1000.00';
const RECALCULATED_BALANCE = '5155.19';
const REDUCED_INSTALLMENT = '703.73';
const FINAL_INSTALLMENT = '703.76';
const SCHEDULE_TOTAL = '5629.87';

describe('payment confirmation flow (e2e): full journey on db_creditos_test', () => {
  let app: INestApplication;
  let dataSource: DataSource;

  let adminToken: string;
  let officeToken: string;
  let officeUserId: string;
  let patientToken: string;
  let patientUserId: string;
  let planId: string;
  let installmentOneId: string;
  let cashMethodIdValue: string;

  async function login(email: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email, password: PASSWORD })
      .expect(201);
    return response.body.token as string;
  }

  async function cashMethodId(): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `SELECT id FROM payment_methods WHERE name = 'cash'`,
    );
    return rows[0].id;
  }

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);

    // Admin has no public registration endpoint; seed it directly (same
    // convention as test/auth.e2e-spec.ts) and log in through real HTTP.
    const adminEmail = `e2e.confirm.admin.${RUN_SUFFIX}@example.com`;
    await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, $2, $3, $4, $5)`,
      [adminEmail, bcrypt.hashSync(PASSWORD, 10), 'E2E Confirm Admin', UserRole.ADMIN, true],
    );
    adminToken = await login(adminEmail);

    // Admin creates the office staff user through the API (admin-only route).
    const officeEmail = `e2e.confirm.office.${RUN_SUFFIX}@example.com`;
    const officeCreated = await request(app.getHttpServer())
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ email: officeEmail, name: 'E2E Confirm Office', password: PASSWORD, role: UserRole.OFFICE })
      .expect(201);
    expect(officeCreated.body.role).toBe(UserRole.OFFICE);
    officeUserId = officeCreated.body.id as string;
    officeToken = await login(officeEmail);

    // Admin creates a doctor through the API; the web account is created
    // atomically with the doctor row (T8).
    const doctorEmail = `e2e.confirm.doctor.${RUN_SUFFIX}@example.com`;
    const doctorCreated = await request(app.getHttpServer())
      .post('/api/doctors')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'E2E Confirm Doctor',
        email: doctorEmail,
        password: PASSWORD,
        specialty: 'General Surgery',
        professionalLicense: `LIC-${RUN_SUFFIX}`,
      })
      .expect(201);
    expect(doctorCreated.body.id).toEqual(expect.any(String));
    const doctorUserRows: IdRow[] = await dataSource.query(
      `SELECT id FROM users WHERE email = $1`,
      [doctorEmail],
    );
    expect(doctorUserRows).toHaveLength(1);

    // Admin creates the hybrid patient record (no web account yet).
    const patientCreated = await request(app.getHttpServer())
      .post('/api/patients')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        identityDocument: `DOC${Date.now().toString(36)}${uniqueCounter++}`,
        firstName: 'E2E Confirm',
        paternalLastName: 'Patient',
        phone: `+51${RUN_SUFFIX}${uniqueCounter++}`,
      })
      .expect(201);
    const patientId = patientCreated.body.id as string;

    // The patient self-registers a web account and admin links it, so the
    // patient owns the future plan (receipt upload requires ownership).
    const patientEmail = `e2e.confirm.patient.${RUN_SUFFIX}@example.com`;
    const patientRegistered = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email: patientEmail, name: 'E2E Confirm Patient', password: PASSWORD })
      .expect(201);
    expect(patientRegistered.body.role).toBe(UserRole.PATIENT);
    patientUserId = patientRegistered.body.id as string;
    patientToken = patientRegistered.body.token as string;
    await request(app.getHttpServer())
      .post(`/api/patients/${patientId}/link-user`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ userId: patientUserId })
      .expect(201);

    // Office schedules the priced surgery from the catalog reference price.
    const catalogCreated = await request(app.getHttpServer())
      .post('/api/surgery-catalog')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ name: `E2E Confirm Appendectomy-${RUN_SUFFIX}`, baseCost: FINANCED_AMOUNT })
      .expect(201);
    const surgeryCreated = await request(app.getHttpServer())
      .post('/api/surgeries')
      .set('Authorization', `Bearer ${officeToken}`)
      .send({
        patientId,
        surgeryCatalogId: catalogCreated.body.id as string,
        scheduledDate: '2999-01-15',
        totalCost: FINANCED_AMOUNT,
      })
      .expect(201);
    expect(surgeryCreated.body.totalCost).toBe(FINANCED_AMOUNT);

    // Office creates the credit plan: the schedule is generated in the same
    // transaction (T1). Far-future start keeps every installment non-overdue,
    // so the plan stays ACTIVE across all effects.
    const planCreated = await request(app.getHttpServer())
      .post('/api/payment-plans')
      .set('Authorization', `Bearer ${officeToken}`)
      .send({
        surgeryId: surgeryCreated.body.id as string,
        type: PaymentPlanType.CREDIT,
        installmentCount: 8,
        monthlyInterestRate: '2.00',
        startDate: '2999-01-01',
      })
      .expect(201);
    planId = planCreated.body.id as string;

    const installmentsResponse = await request(app.getHttpServer())
      .get(`/api/payment-plans/${planId}/installments`)
      .set('Authorization', `Bearer ${officeToken}`)
      .expect(200);
    installmentOneId = installmentsResponse.body[0].id as string;
    cashMethodIdValue = await cashMethodId();
  });

  afterAll(async () => {
    await app.close();
  });

  function planRows(): Promise<PlanRow[]> {
    return dataSource.query(
      `SELECT outstanding_balance::text AS outstanding_balance, status
       FROM payment_plans WHERE id = $1`,
      [planId],
    );
  }

  function installmentRows(): Promise<InstallmentRow[]> {
    return dataSource.query(
      `SELECT id, installment_number, principal_amount::text AS principal_amount,
              interest_amount::text AS interest_amount,
              total_amount::text AS total_amount,
              paid_amount::text AS paid_amount, status
       FROM installments WHERE payment_plan_id = $1
       ORDER BY installment_number`,
      [planId],
    );
  }

  function paymentCountForPlan(): Promise<{ count: string }[]> {
    return dataSource.query(
      `SELECT COUNT(*)::text AS count FROM payments WHERE payment_plan_id = $1`,
      [planId],
    );
  }

  function auditRowsFor(recordId: string, action: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT user_id, action, table_name, record_id, previous_data, new_data
       FROM audit_logs WHERE record_id = $1 AND action = $2
       ORDER BY created_at`,
      [recordId, action],
    );
  }

  function registerPayment(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/payments')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('schedules the credit plan with the generated French schedule and audits plan creation exactly once', async () => {
    const detail = await request(app.getHttpServer())
      .get(`/api/payment-plans/${planId}`)
      .set('Authorization', `Bearer ${officeToken}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      type: PaymentPlanType.CREDIT,
      downPayment: '0.00',
      financedAmount: FINANCED_AMOUNT,
      monthlyInterestRate: '2.00',
      installmentCount: 8,
      startDate: '2999-01-01',
      outstandingBalance: FINANCED_AMOUNT,
      status: PaymentPlanStatus.ACTIVE,
    });

    // The generated schedule: 8 pending lines at A = 840.24; the first line
    // credits interest 123.10 and principal 717.14, and the principal sums
    // exactly to the financed amount (last line absorbs the remainder).
    const installmentsResponse = await request(app.getHttpServer())
      .get(`/api/payment-plans/${planId}/installments`)
      .set('Authorization', `Bearer ${officeToken}`)
      .expect(200);
    const installments = installmentsResponse.body as {
      totalAmount: string;
      principalAmount: string;
      interestAmount: string;
      status: string;
      overdue: boolean;
    }[];
    expect(installments).toHaveLength(8);
    expect(installments[0]).toMatchObject({
      totalAmount: '840.24',
      principalAmount: '717.14',
      interestAmount: '123.10',
      status: InstallmentStatus.PENDING,
      overdue: false,
    });
    for (const installment of installments) {
      expect(installment.status).toBe(InstallmentStatus.PENDING);
      expect(installment.overdue).toBe(false);
    }
    const principalSums: { total: string }[] = await dataSource.query(
      `SELECT SUM(principal_amount)::text AS total FROM installments WHERE payment_plan_id = $1`,
      [planId],
    );
    expect(principalSums[0].total).toBe(FINANCED_AMOUNT);

    // T1 audits plan creation exactly once, in the same transaction.
    const planAudits = await auditRowsFor(planId, 'payment_plan.created');
    expect(planAudits).toHaveLength(1);
    expect(planAudits[0].user_id).toBe(officeUserId);
    expect(planAudits[0].table_name).toBe('payment_plans');
    expect(planAudits[0].new_data?.outstandingBalance).toBe(FINANCED_AMOUNT);
    expect(planAudits[0].new_data?.installments).toHaveLength(8);
  });

  it('auto-confirms the office amortization and recalculates the schedule to Option A (703.73 x 7 + 703.76)', async () => {
    const response = await registerPayment(officeToken, {
      paymentPlanId: planId,
      paymentMethodId: cashMethodIdValue,
      amount: AMORTIZATION_AMOUNT,
      type: PaymentType.PRINCIPAL_AMORTIZATION,
      amortizationMode: AmortizationMode.REDUCE_INSTALLMENT,
    });

    // T2: an office registration auto-confirms in the same transaction.
    expect(response.status).toBe(201);
    expect(response.body.status).toBe(PaymentStatus.CONFIRMED);
    expect(response.body.type).toBe(PaymentType.PRINCIPAL_AMORTIZATION);
    expect(response.body.amount).toBe(AMORTIZATION_AMOUNT);
    expect(response.body.amortizationMode).toBe(AmortizationMode.REDUCE_INSTALLMENT);
    expect(response.body.patientUserId).toBeNull();
    expect(response.body.recordedByUserId).toBe(officeUserId);
    const paymentId = response.body.id as string;

    // Balance drops to the pinned 5,155.19 and the plan stays ACTIVE.
    const plan = (await planRows())[0];
    expect(plan.outstanding_balance).toBe(RECALCULATED_BALANCE);
    expect(plan.status).toBe(PaymentPlanStatus.ACTIVE);

    // Design 7 Option A: pending lines recompute to 703.73 x 7 plus a final
    // 703.76 (principal 689.96 + interest 13.80) absorbing the remainder;
    // the schedule sums to 5,629.87.
    const installments = await installmentRows();
    expect(installments).toHaveLength(8);
    for (let index = 0; index < 7; index++) {
      expect(installments[index]).toMatchObject({
        total_amount: REDUCED_INSTALLMENT,
        status: InstallmentStatus.PENDING,
      });
    }
    expect(installments[7]).toMatchObject({
      principal_amount: '689.96',
      interest_amount: '13.80',
      total_amount: FINAL_INSTALLMENT,
      status: InstallmentStatus.PENDING,
    });
    const scheduleSums: { total: string }[] = await dataSource.query(
      `SELECT SUM(total_amount)::text AS total FROM installments WHERE payment_plan_id = $1`,
      [planId],
    );
    expect(scheduleSums[0].total).toBe(SCHEDULE_TOTAL);

    // Two in-transaction audit entries: the confirmation (with the new
    // balance) and the recalculation (with pre/post balance and schedule).
    const confirmAudits = await auditRowsFor(paymentId, 'payment.confirmed');
    expect(confirmAudits).toHaveLength(1);
    expect(confirmAudits[0].user_id).toBe(officeUserId);
    expect(confirmAudits[0].table_name).toBe('payments');
    expect(confirmAudits[0].previous_data?.status).toBe(PaymentStatus.PENDING_CONFIRMATION);
    expect(confirmAudits[0].new_data?.status).toBe(PaymentStatus.CONFIRMED);
    expect(confirmAudits[0].new_data?.outstandingBalance).toBe(RECALCULATED_BALANCE);
    expect(confirmAudits[0].new_data?.type).toBe(PaymentType.PRINCIPAL_AMORTIZATION);
    expect(confirmAudits[0].new_data?.amortizationMode).toBe(AmortizationMode.REDUCE_INSTALLMENT);

    const recalcAudits = await auditRowsFor(planId, 'payment_plan.recalculated');
    expect(recalcAudits).toHaveLength(1);
    expect(recalcAudits[0].user_id).toBe(officeUserId);
    expect(recalcAudits[0].table_name).toBe('payment_plans');
    expect(recalcAudits[0].previous_data?.outstandingBalance).toBe(FINANCED_AMOUNT);
    expect(recalcAudits[0].new_data?.outstandingBalance).toBe(RECALCULATED_BALANCE);
    expect(recalcAudits[0].previous_data?.installments).toHaveLength(8);
    expect(recalcAudits[0].new_data?.installments).toHaveLength(8);
    expect(recalcAudits[0].new_data?.installments?.[0].totalAmount).toBe(REDUCED_INSTALLMENT);
    expect(recalcAudits[0].new_data?.installments?.[7].totalAmount).toBe(FINAL_INSTALLMENT);
  });

  it('keeps the patient receipt upload pending with no balance, schedule or audit effect', async () => {
    // The patient (linked owner) uploads a receipt for the first installment.
    const upload = await registerPayment(patientToken, {
      paymentPlanId: planId,
      installmentId: installmentOneId,
      paymentMethodId: cashMethodIdValue,
      amount: '500.00',
      type: PaymentType.INSTALLMENT_PAYMENT,
      receiptUrl: 'https://receipts.example/e2e-confirm-receipt.png',
    });

    // T3: the row stays pending_confirmation, patient-attributed on both sides.
    expect(upload.status).toBe(201);
    expect(upload.body.status).toBe(PaymentStatus.PENDING_CONFIRMATION);
    expect(upload.body.patientUserId).toBe(patientUserId);
    expect(upload.body.recordedByUserId).toBe(patientUserId);
    const pendingPaymentId = upload.body.id as string;

    // No balance, installment or schedule effect occurs...
    const plan = (await planRows())[0];
    expect(plan.outstanding_balance).toBe(RECALCULATED_BALANCE);
    const installments = await installmentRows();
    expect(installments[0]).toMatchObject({
      paid_amount: '0.00',
      status: InstallmentStatus.PENDING,
    });
    expect(installments[0].total_amount).toBe(REDUCED_INSTALLMENT);
    expect(await paymentCountForPlan()).toEqual([{ count: '2' }]);

    // ...and the linked patient can read the plan through the API.
    const patientRead = await request(app.getHttpServer())
      .get(`/api/payment-plans/${planId}`)
      .set('Authorization', `Bearer ${patientToken}`)
      .expect(200);
    expect(patientRead.body.outstandingBalance).toBe(RECALCULATED_BALANCE);

    // T3 registers without audit: no confirmation entry for this payment.
    expect(await auditRowsFor(pendingPaymentId, 'payment.confirmed')).toHaveLength(0);
    expect(await auditRowsFor(pendingPaymentId, 'payment.rejected')).toHaveLength(0);
  });

  it('rejects the office overpayment with 409 and persists nothing (D1)', async () => {
    // The recalculated first installment totals 703.73; paying 800.00 would
    // push paid_amount past total_amount -> design D1 conflict.
    const response = await registerPayment(officeToken, {
      paymentPlanId: planId,
      installmentId: installmentOneId,
      paymentMethodId: cashMethodIdValue,
      amount: '800.00',
      type: PaymentType.INSTALLMENT_PAYMENT,
    });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe(
      "amount exceeds the installment's remaining balance; use a principal_amortization for extra payments",
    );
    expect(await paymentCountForPlan()).toEqual([{ count: '2' }]);
    const plan = (await planRows())[0];
    expect(plan.outstanding_balance).toBe(RECALCULATED_BALANCE);
    const installments = await installmentRows();
    expect(installments[0].paid_amount).toBe('0.00');
  });

  it('rejects a disabled payment method with 409 and persists nothing', async () => {
    // Create a unique method and retire it; disabled methods reject on use.
    const created = await request(app.getHttpServer())
      .post('/api/payment-methods')
      .set('Authorization', `Bearer ${officeToken}`)
      .send({ name: `E2E Confirm Disabled-${RUN_SUFFIX}`, isEnabled: true })
      .expect(201);
    const disabledMethodId = created.body.id as string;
    await request(app.getHttpServer())
      .patch(`/api/payment-methods/${disabledMethodId}`)
      .set('Authorization', `Bearer ${officeToken}`)
      .send({ isEnabled: false })
      .expect(200);

    const response = await registerPayment(officeToken, {
      paymentPlanId: planId,
      installmentId: installmentOneId,
      paymentMethodId: disabledMethodId,
      amount: '100.00',
      type: PaymentType.INSTALLMENT_PAYMENT,
    });

    // Spec "Disabled method rejected": 409 Conflict, nothing persisted.
    expect(response.status).toBe(409);
    expect(response.body.message).toBe('Payment method is disabled');
    expect(await paymentCountForPlan()).toEqual([{ count: '2' }]);
    const plan = (await planRows())[0];
    expect(plan.outstanding_balance).toBe(RECALCULATED_BALANCE);
  });

  it('rejects the pending receipt with zero side effects and audits the rejection', async () => {
    // The patient upload is the single pending payment of the journey.
    const pendingRows: IdRow[] = await dataSource.query(
      `SELECT id FROM payments WHERE payment_plan_id = $1 AND status = 'pending_confirmation'`,
      [planId],
    );
    expect(pendingRows).toHaveLength(1);
    const pendingPaymentId = pendingRows[0].id;

    // T5: office rejection changes only the status.
    const response = await request(app.getHttpServer())
      .post(`/api/payments/${pendingPaymentId}/reject`)
      .set('Authorization', `Bearer ${officeToken}`)
      .expect(200);
    expect(response.body.status).toBe(PaymentStatus.REJECTED);

    // Side-effect free: balance and schedule untouched.
    const plan = (await planRows())[0];
    expect(plan.outstanding_balance).toBe(RECALCULATED_BALANCE);
    const installments = await installmentRows();
    expect(installments[0]).toMatchObject({
      paid_amount: '0.00',
      status: InstallmentStatus.PENDING,
    });

    // Exactly one audit entry, actor-attributed, with the status transition.
    const rejectAudits = await auditRowsFor(pendingPaymentId, 'payment.rejected');
    expect(rejectAudits).toHaveLength(1);
    expect(rejectAudits[0].user_id).toBe(officeUserId);
    expect(rejectAudits[0].table_name).toBe('payments');
    expect(rejectAudits[0].previous_data?.status).toBe(PaymentStatus.PENDING_CONFIRMATION);
    expect(rejectAudits[0].new_data?.status).toBe(PaymentStatus.REJECTED);
    expect(await auditRowsFor(pendingPaymentId, 'payment.confirmed')).toHaveLength(0);
  });
});
