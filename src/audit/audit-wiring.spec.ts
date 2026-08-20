import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource, EntityManager } from 'typeorm';
import {
  AmortizationMode,
  InstallmentStatus,
  PaymentPlanStatus,
  PaymentPlanType,
  PaymentStatus,
  PaymentType,
  SurgeryStatus,
  UserRole,
} from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { AuditService } from './audit.service';

jest.setTimeout(60000);

// The spec shares db_creditos_test with the other integration suites that run
// in parallel (npm test), so it never truncates: every email, phone, identity
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
  outstanding_balance: string;
}

interface InstallmentRow {
  id: string;
  installment_number: number;
  paid_amount: string;
  total_amount: string;
  status: string;
}

interface AuditRow {
  user_id: string | null;
  action: string;
  table_name: string;
  record_id: string;
  previous_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
}

/**
 * End-to-end audit wiring proof (task 14.1, audit-logging spec). Every action
 * of the vocabulary is exercised through the REAL API on db_creditos_test and
 * the exact persisted rows are asserted: action, actor user_id, table_name,
 * record_id and the jsonb previous_data/new_data contents. The suite also
 * proves the in-transaction contract: a rolled-back operation leaves no audit
 * row, and system actions (user_id NULL) persist through AuditService.
 */
describe('audit wiring end-to-end (design 5.12, audit-logging spec)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;
  let auditService: AuditService;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);
    auditService = app.get(AuditService);
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
      emailFor(`office.audit.${uniqueCounter++}`),
      'Office Audit',
      UserRole.OFFICE,
    );
    return { id, token: await tokenForUserId(id) };
  }

  async function patientUser(): Promise<{ id: string; token: string }> {
    const id = await insertUserRaw(
      emailFor(`patient.audit.${uniqueCounter++}`),
      'Patient Audit',
      UserRole.PATIENT,
    );
    return { id, token: await tokenForUserId(id) };
  }

  async function createPatientRaw(
    userId: string | null = null,
  ): Promise<string> {
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

  async function createCatalogEntry(token: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/surgery-catalog')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: `AuditSpec-${RUN_SUFFIX}-${uniqueCounter++}`,
        baseCost: '8000.00',
      });
    expect(response.status).toBe(201);
    return response.body.id as string;
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

  async function changeSurgeryStatus(
    token: string,
    surgeryId: string,
    status: SurgeryStatus,
  ) {
    return request(app.getHttpServer())
      .patch(`/api/surgeries/${surgeryId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status });
  }

  async function createPlan(
    officeToken: string,
    patientId: string,
    totalCost: string,
    installmentCount: number,
  ): Promise<{ planId: string; surgeryId: string }> {
    const catalogId = await createCatalogEntry(officeToken);
    const surgeryId = await createSurgery(
      officeToken,
      patientId,
      catalogId,
      totalCost,
    );
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

  async function cashMethodId(): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `SELECT id FROM payment_methods WHERE name = 'cash'`,
    );
    return rows[0].id;
  }

  async function createDisabledPaymentMethod(token: string): Promise<string> {
    const created = await request(app.getHttpServer())
      .post('/api/payment-methods')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: `Disabled-${RUN_SUFFIX}-${uniqueCounter++}`,
        isEnabled: true,
      });
    expect(created.status).toBe(201);
    const disabled = await request(app.getHttpServer())
      .patch(`/api/payment-methods/${created.body.id as string}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ isEnabled: false });
    expect(disabled.status).toBe(200);
    return created.body.id as string;
  }

  async function installmentRows(planId: string): Promise<InstallmentRow[]> {
    return dataSource.query(
      `SELECT id, installment_number, paid_amount::text AS paid_amount,
              total_amount::text AS total_amount, status
       FROM installments WHERE payment_plan_id = $1
       ORDER BY installment_number`,
      [planId],
    );
  }

  async function installmentIdFor(
    planId: string,
    number: number,
  ): Promise<string> {
    const rows = await installmentRows(planId);
    const match = rows.find((row) => row.installment_number === number);
    if (!match) throw new Error(`installment ${number} not found`);
    return match.id;
  }

  async function planRows(planId: string): Promise<PlanRow[]> {
    return dataSource.query(
      `SELECT id, outstanding_balance::text AS outstanding_balance
       FROM payment_plans WHERE id = $1`,
      [planId],
    );
  }

  async function auditRowsForRecord(recordId: string): Promise<AuditRow[]> {
    return dataSource.query(
      `SELECT user_id, action, table_name, record_id, previous_data, new_data
       FROM audit_logs WHERE record_id = $1
       ORDER BY created_at`,
      [recordId],
    );
  }

  async function auditCountForActor(actorId: string): Promise<number> {
    const rows: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*)::text AS count FROM audit_logs WHERE user_id = $1`,
      [actorId],
    );
    return Number(rows[0].count);
  }

  async function auditCountForAction(action: string): Promise<number> {
    const rows: { count: string }[] = await dataSource.query(
      `SELECT COUNT(*)::text AS count FROM audit_logs WHERE action = $1`,
      [action],
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

  describe('full flow: surgery -> status change -> plan -> payments (T6, T1, T2-T5)', () => {
    it('writes exactly the five expected audit rows with actors and jsonb contents', async () => {
      const office = await officeUser();
      const patient = await patientUser();
      const patientId = await createPatientRaw(patient.id);
      const catalogId = await createCatalogEntry(office.token);

      // T6: the surgery is created scheduled and the office performs it.
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalogId,
        '10000.00',
      );
      const statusResponse = await changeSurgeryStatus(
        office.token,
        surgeryId,
        SurgeryStatus.PERFORMED,
      );
      expect(statusResponse.status).toBe(200);
      expect(statusResponse.body.status).toBe(SurgeryStatus.PERFORMED);

      const statusAudits = await auditRowsForRecord(surgeryId);
      expect(statusAudits).toHaveLength(1);
      expect(statusAudits[0]).toMatchObject({
        user_id: office.id,
        action: 'surgery.status_changed',
        table_name: 'surgeries',
        record_id: surgeryId,
        previous_data: { status: SurgeryStatus.SCHEDULED },
        new_data: { status: SurgeryStatus.PERFORMED },
      });

      // T1: the credit plan over the full 10,000.00 cost; the creation is
      // audited with the plan and its generated schedule.
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

      const creationAudits = await auditRowsForRecord(planId);
      expect(creationAudits).toHaveLength(1);
      expect(creationAudits[0]).toMatchObject({
        user_id: office.id,
        action: 'payment_plan.created',
        table_name: 'payment_plans',
        record_id: planId,
        previous_data: null,
      });
      expect(creationAudits[0].new_data).toMatchObject({
        type: PaymentPlanType.CREDIT,
        downPayment: '0.00',
        financedAmount: '10000.00',
        monthlyInterestRate: '2.00',
        installmentCount: 10,
        startDate: '2026-01-01',
        outstandingBalance: '10000.00',
        status: PaymentPlanStatus.ACTIVE,
      });
      const createdSchedule = creationAudits[0].new_data
        ?.installments as Record<string, unknown>[];
      expect(createdSchedule).toHaveLength(10);
      expect(createdSchedule[0]).toMatchObject({
        installmentNumber: 1,
        principalAmount: '913.27',
        interestAmount: '200.00',
        totalAmount: '1113.27',
        dueDate: '2026-02-01',
      });

      // T2: the office registers an installment payment at the counter; the
      // row auto-confirms in the same transaction and is audited once.
      const installment1 = await installmentIdFor(planId, 1);
      const autoConfirmed = await registerPayment(office.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: await cashMethodId(),
        amount: '1113.27',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });
      expect(autoConfirmed.status).toBe(201);
      expect(autoConfirmed.body.status).toBe(PaymentStatus.CONFIRMED);
      const autoPaymentId = autoConfirmed.body.id as string;

      const autoConfirmAudits = await auditRowsForRecord(autoPaymentId);
      expect(autoConfirmAudits).toHaveLength(1);
      expect(autoConfirmAudits[0]).toMatchObject({
        user_id: office.id,
        action: 'payment.confirmed',
        table_name: 'payments',
        record_id: autoPaymentId,
        previous_data: { status: PaymentStatus.PENDING_CONFIRMATION },
        new_data: {
          status: PaymentStatus.CONFIRMED,
          type: PaymentType.INSTALLMENT_PAYMENT,
          amount: '1113.27',
          outstandingBalance: '9086.73',
          installment: {
            id: installment1,
            status: InstallmentStatus.PAID,
            paidAmount: '1113.27',
          },
        },
      });
      // The vocabulary has no 'payment.created' action: auto-confirm is
      // audited only as payment.confirmed (audit-logging spec, design 5.12).
      expect(await auditCountForAction('payment.created')).toBe(0);

      // T3: the patient uploads a receipt; it stays pending_confirmation with
      // NO audit entry until an office user confirms or rejects it.
      const installment2 = await installmentIdFor(planId, 2);
      const upload = await registerPayment(patient.token, {
        paymentPlanId: planId,
        installmentId: installment2,
        paymentMethodId: await cashMethodId(),
        amount: '500.00',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });
      expect(upload.status).toBe(201);
      expect(upload.body.status).toBe(PaymentStatus.PENDING_CONFIRMATION);
      const pendingPaymentId = upload.body.id as string;
      expect(await auditRowsForRecord(pendingPaymentId)).toHaveLength(0);

      // T4: the office confirms the receipt; the audit row appears with the
      // office actor, the status transition and the applied effects
      // (creditPrincipal(500) = 418.38 over installment 2's principal 931.54).
      const confirmResponse = await confirmPayment(
        office.token,
        pendingPaymentId,
      );
      expect(confirmResponse.status).toBe(200);
      expect(confirmResponse.body.status).toBe(PaymentStatus.CONFIRMED);

      const confirmAudits = await auditRowsForRecord(pendingPaymentId);
      expect(confirmAudits).toHaveLength(1);
      expect(confirmAudits[0]).toMatchObject({
        user_id: office.id,
        action: 'payment.confirmed',
        table_name: 'payments',
        record_id: pendingPaymentId,
        previous_data: { status: PaymentStatus.PENDING_CONFIRMATION },
        new_data: {
          status: PaymentStatus.CONFIRMED,
          outstandingBalance: '8668.35',
          installment: {
            id: installment2,
            status: InstallmentStatus.PARTIAL,
            paidAmount: '500.00',
          },
        },
      });

      // T5: the patient uploads an amortization that the office rejects; the
      // rejection is side-effect free (balance untouched) and audited once.
      const planBeforeReject = (await planRows(planId))[0];
      expect(planBeforeReject.outstanding_balance).toBe('8668.35');
      const rejectUpload = await registerPayment(patient.token, {
        paymentPlanId: planId,
        paymentMethodId: await cashMethodId(),
        amount: '3000.00',
        type: PaymentType.PRINCIPAL_AMORTIZATION,
        amortizationMode: AmortizationMode.REDUCE_INSTALLMENT,
      });
      expect(rejectUpload.status).toBe(201);
      const rejectedPaymentId = rejectUpload.body.id as string;

      const rejectResponse = await rejectPayment(
        office.token,
        rejectedPaymentId,
      );
      expect(rejectResponse.status).toBe(200);
      expect(rejectResponse.body.status).toBe(PaymentStatus.REJECTED);
      expect((await planRows(planId))[0].outstanding_balance).toBe('8668.35');

      const rejectAudits = await auditRowsForRecord(rejectedPaymentId);
      expect(rejectAudits).toHaveLength(1);
      expect(rejectAudits[0]).toMatchObject({
        user_id: office.id,
        action: 'payment.rejected',
        table_name: 'payments',
        record_id: rejectedPaymentId,
        previous_data: { status: PaymentStatus.PENDING_CONFIRMATION },
        new_data: { status: PaymentStatus.REJECTED },
      });

      // The whole journey wrote exactly five rows, all attributed to the
      // office actor (patient uploads are never audited).
      expect(await auditCountForActor(office.id)).toBe(5);
    });
  });

  describe('recalculation (T4 amortization): payment_plan.recalculated payload', () => {
    it('holds the pre-recalculation balance and schedule in previous_data and the post state in new_data', async () => {
      const office = await officeUser();
      const patient = await patientUser();
      const patientId = await createPatientRaw(patient.id);
      // Financed 6,155.19 @2% n=8; amortizing 1,000.00 leaves the pinned
      // balance 5,155.19 -> A = 703.73, lines 1-7 at 703.73, line 8 = 703.76
      // (design 7, Option A). The original schedule lines total 840.24 with a
      // 840.27 last line (remainder absorption, design 6.2).
      const { planId } = await createPlan(
        office.token,
        patientId,
        '6155.19',
        8,
      );

      const upload = await registerPayment(patient.token, {
        paymentPlanId: planId,
        paymentMethodId: await cashMethodId(),
        amount: '1000.00',
        type: PaymentType.PRINCIPAL_AMORTIZATION,
        amortizationMode: AmortizationMode.REDUCE_INSTALLMENT,
      });
      expect(upload.status).toBe(201);
      const paymentId = upload.body.id as string;
      expect(await auditRowsForRecord(paymentId)).toHaveLength(0);

      const response = await confirmPayment(office.token, paymentId);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe(PaymentStatus.CONFIRMED);

      // The confirmation itself is audited on the payment row...
      const confirmAudits = await auditRowsForRecord(paymentId);
      expect(confirmAudits).toHaveLength(1);
      expect(confirmAudits[0].action).toBe('payment.confirmed');
      expect(confirmAudits[0].user_id).toBe(office.id);
      expect(confirmAudits[0].new_data).toMatchObject({
        status: PaymentStatus.CONFIRMED,
        type: PaymentType.PRINCIPAL_AMORTIZATION,
        outstandingBalance: '5155.19',
      });

      // ...and the recalculation is audited on the plan row, exactly once.
      const planAudits = await auditRowsForRecord(planId);
      const recalcAudits = planAudits.filter(
        (row) => row.action === 'payment_plan.recalculated',
      );
      expect(recalcAudits).toHaveLength(1);
      expect(recalcAudits[0]).toMatchObject({
        user_id: office.id,
        action: 'payment_plan.recalculated',
        table_name: 'payment_plans',
        record_id: planId,
      });
      expect(recalcAudits[0].previous_data).toMatchObject({
        outstandingBalance: '6155.19',
      });
      const previousInstallments = recalcAudits[0].previous_data
        ?.installments as Record<string, unknown>[];
      expect(previousInstallments).toHaveLength(8);
      expect(previousInstallments[0]).toMatchObject({
        installmentNumber: 1,
        totalAmount: '840.24',
        status: InstallmentStatus.PENDING,
      });
      expect(previousInstallments[7]).toMatchObject({
        installmentNumber: 8,
        totalAmount: '840.27',
        status: InstallmentStatus.PENDING,
      });
      expect(recalcAudits[0].new_data).toMatchObject({
        outstandingBalance: '5155.19',
      });
      const recalculatedInstallments = recalcAudits[0].new_data
        ?.installments as Record<string, unknown>[];
      expect(recalculatedInstallments).toHaveLength(8);
      expect(recalculatedInstallments[0]).toMatchObject({
        installmentNumber: 1,
        totalAmount: '703.73',
        status: InstallmentStatus.PENDING,
      });
      expect(recalculatedInstallments[7]).toMatchObject({
        installmentNumber: 8,
        principalAmount: '689.96',
        interestAmount: '13.80',
        totalAmount: '703.76',
        status: InstallmentStatus.PENDING,
      });
    });
  });

  describe('rollback leaves no audit entry', () => {
    it('writes no audit when a confirmation fails mid-transaction (overpayment 409)', async () => {
      const office = await officeUser();
      const patient = await patientUser();
      const patientId = await createPatientRaw(patient.id);
      const { planId } = await createPlan(
        office.token,
        patientId,
        '10000.00',
        10,
      );
      const installment1 = await installmentIdFor(planId, 1);

      const upload = await registerPayment(patient.token, {
        paymentPlanId: planId,
        installmentId: installment1,
        paymentMethodId: await cashMethodId(),
        amount: '1113.28',
        type: PaymentType.INSTALLMENT_PAYMENT,
      });
      expect(upload.status).toBe(201);
      const paymentId = upload.body.id as string;

      const response = await confirmPayment(office.token, paymentId);

      // Design D1: paid_amount + amount would exceed the installment total.
      expect(response.status).toBe(409);
      // The failed confirmation left no audit row for the payment, no
      // recalculation for the plan, and no balance or installment effect.
      expect(await auditRowsForRecord(paymentId)).toHaveLength(0);
      expect(await auditRowsForRecord(planId)).toHaveLength(1); // only the creation
      expect((await planRows(planId))[0].outstanding_balance).toBe('10000.00');
      const installments = await installmentRows(planId);
      expect(installments[0]).toMatchObject({
        paid_amount: '0.00',
        status: InstallmentStatus.PENDING,
      });
    });

    it('writes no audit when plan creation fails (disabled down-payment method 409)', async () => {
      const office = await officeUser();
      const disabledMethodId = await createDisabledPaymentMethod(office.token);
      const patientId = await createPatientRaw();
      const catalogId = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalogId,
        '10000.00',
      );

      const response = await request(app.getHttpServer())
        .post('/api/payment-plans')
        .set('Authorization', `Bearer ${office.token}`)
        .send({
          surgeryId,
          type: PaymentPlanType.CREDIT,
          installmentCount: 10,
          monthlyInterestRate: '2.00',
          startDate: '2026-01-01',
          downPayment: '2000.00',
          paymentMethodId: disabledMethodId,
        });

      expect(response.status).toBe(409);
      expect(response.body.message).toBe('Payment method is disabled');
      // The whole T1 transaction rolled back: no plan and no audit entry
      // attributed to this actor.
      const plans: IdRow[] = await dataSource.query(
        `SELECT id FROM payment_plans WHERE surgery_id = $1`,
        [surgeryId],
      );
      expect(plans).toHaveLength(0);
      expect(await auditCountForActor(office.id)).toBe(0);
    });
  });

  describe('system action attribution (user_id NULL)', () => {
    it('persists audit rows with NULL user_id through AuditService (cron contract)', async () => {
      const office = await officeUser();
      const patientId = await createPatientRaw();
      const catalogId = await createCatalogEntry(office.token);
      const surgeryId = await createSurgery(
        office.token,
        patientId,
        catalogId,
        '10000.00',
      );

      // No scheduled job exists in this codebase yet; the audit-logging spec
      // scenario "System action attribution" is proven at the contract
      // boundary: AuditService.log inside a real transaction with userId null
      // persists a row whose user_id IS NULL (design 5.12).
      await dataSource.transaction(async (manager: EntityManager) => {
        await auditService.log(manager, {
          userId: null,
          action: 'surgery.status_changed',
          tableName: 'surgeries',
          recordId: surgeryId,
          previousData: { status: SurgeryStatus.SCHEDULED },
          newData: { status: SurgeryStatus.PERFORMED },
        });
      });

      const rows: AuditRow[] = await dataSource.query(
        `SELECT user_id, action, table_name, record_id, previous_data, new_data
         FROM audit_logs
         WHERE record_id = $1 AND action = 'surgery.status_changed'`,
        [surgeryId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBeNull();
      expect(rows[0].table_name).toBe('surgeries');
      expect(rows[0].previous_data).toEqual({
        status: SurgeryStatus.SCHEDULED,
      });
      expect(rows[0].new_data).toEqual({ status: SurgeryStatus.PERFORMED });
    });
  });
});
