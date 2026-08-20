import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { User } from '../auth/entities/user.entity';
import {
  InstallmentStatus,
  PaymentPlanStatus,
  PaymentStatus,
  PaymentType,
  UserRole,
} from '../common/enums';
import { handleDatabaseError } from '../common/errors';
import { PaymentMethod } from '../payment-methods/entities/payment-method.entity';
import { Installment, PaymentPlan } from '../payment-plans/entities';
import { RecalculationStrategyFactory } from '../payment-plans/strategies';
import { CreatePaymentDto } from './dto';
import { Payment } from './entities';

const MONEY_DECIMALS = 2;
const HALF_UP_ROUNDING = Decimal.ROUND_HALF_UP;
const AUDIT_ACTION_PAYMENT_CONFIRMED = 'payment.confirmed';
const AUDIT_ACTION_PAYMENT_REJECTED = 'payment.rejected';
const AUDIT_ACTION_PLAN_RECALCULATED = 'payment_plan.recalculated';
const AUDIT_TABLE_PAYMENTS = 'payments';
const AUDIT_TABLE_PAYMENT_PLANS = 'payment_plans';

/**
 * T2-T5 payment processing (design section 8). Money movements run inside ONE
 * transaction that locks the plan row FOR UPDATE first (the serialization
 * point for every effect path), writes the audit entries through the same
 * EntityManager, and rolls everything back on any failure. Money stays in
 * decimal strings end to end (design AD2).
 */
@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly recalculationStrategyFactory: RecalculationStrategyFactory,
  ) {}

  /**
   * T2/T3 (design section 8.1): office/admin registrations auto-confirm in
   * the same transaction (row + effects + evaluation + audit); patient receipt
   * uploads are stored pending_confirmation with no effects and no audit.
   */
  async register(
    createPaymentDto: CreatePaymentDto,
    currentUser: User,
  ): Promise<Payment> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const isStaff = this.isStaff(currentUser);
        this.assertTypeIntegrity(createPaymentDto);
        if (new Decimal(createPaymentDto.amount).lte(0)) {
          throw new BadRequestException('amount must be greater than zero');
        }
        // Down payments only exist at plan creation (design AD4); a patient
        // receipt upload can never be one.
        if (!isStaff && createPaymentDto.type === PaymentType.DOWN_PAYMENT) {
          throw new BadRequestException(
            'down payments are only registered at plan creation',
          );
        }

        const paymentMethod = await manager.findOne(PaymentMethod, {
          where: { id: createPaymentDto.paymentMethodId },
        });
        if (!paymentMethod) {
          throw new NotFoundException('Payment method not found');
        }
        if (!paymentMethod.isEnabled) {
          throw new ConflictException('Payment method is disabled');
        }

        const plan = await manager.findOne(PaymentPlan, {
          where: { id: createPaymentDto.paymentPlanId },
        });
        if (!plan) throw new NotFoundException('Payment plan not found');
        if (!isStaff) {
          await this.assertPatientOwnsPlan(manager, plan, currentUser);
        }

        if (createPaymentDto.installmentId) {
          const installment = await manager.findOne(Installment, {
            where: { id: createPaymentDto.installmentId },
          });
          if (!installment || installment.paymentPlanId !== plan.id) {
            throw new NotFoundException('Installment not found');
          }
        }

        const payment = await manager.save(
          manager.create(Payment, {
            paymentPlanId: plan.id,
            installmentId: createPaymentDto.installmentId ?? null,
            patientUserId: isStaff ? null : currentUser.id,
            recordedByUserId: currentUser.id,
            paymentMethodId: paymentMethod.id,
            amount: createPaymentDto.amount,
            type: createPaymentDto.type,
            amortizationMode: createPaymentDto.amortizationMode ?? null,
            receiptUrl: createPaymentDto.receiptUrl ?? null,
            status: PaymentStatus.PENDING_CONFIRMATION,
          }),
        );

        if (isStaff) {
          await this.applyPaymentEffects(manager, payment, currentUser.id);
        }
        return payment;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  /**
   * T4 (design section 8.2): office/admin confirmation. The payment row is
   * locked first and must be pending (both targets are terminal), then the
   * plan row is locked FOR UPDATE inside the same transaction and the shared
   * effect/audit core runs; any failure rolls everything back.
   */
  async confirm(id: string, currentUser: User): Promise<Payment> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const payment = await manager.findOne(Payment, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!payment) throw new NotFoundException('Payment not found');
        if (payment.status !== PaymentStatus.PENDING_CONFIRMATION) {
          throw new ConflictException(
            'Payment is already confirmed or rejected',
          );
        }
        await this.applyPaymentEffects(manager, payment, currentUser.id);
        return payment;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  /**
   * T5 (design section 8.1): office/admin rejection is side-effect free —
   * only the status transition and its audit entry are written.
   */
  async reject(id: string, currentUser: User): Promise<Payment> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const payment = await manager.findOne(Payment, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!payment) throw new NotFoundException('Payment not found');
        if (payment.status !== PaymentStatus.PENDING_CONFIRMATION) {
          throw new ConflictException(
            'Payment is already confirmed or rejected',
          );
        }
        payment.status = PaymentStatus.REJECTED;
        await manager.save(payment);
        await this.auditService.log(manager, {
          userId: currentUser.id,
          action: AUDIT_ACTION_PAYMENT_REJECTED,
          tableName: AUDIT_TABLE_PAYMENTS,
          recordId: payment.id,
          previousData: { status: PaymentStatus.PENDING_CONFIRMATION },
          newData: { status: PaymentStatus.REJECTED },
        });
        return payment;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  /**
   * Read side (design section 11): office/admin see every payment; a patient
   * only the payments of their own plan (ownership derived through
   * surgery.patient.user_id, which also covers office-recorded rows whose
   * patient_user_id is NULL) plus their own receipt uploads.
   */
  async findAll(currentUser: User): Promise<Payment[]> {
    const payments = await this.paymentRepository.find({
      relations: [
        'paymentPlan',
        'paymentPlan.surgery',
        'paymentPlan.surgery.patient',
      ],
      order: { paidAt: 'DESC' },
    });
    if (!this.isStaff(currentUser)) {
      return payments.filter(
        (payment) =>
          payment.patientUserId === currentUser.id ||
          payment.paymentPlan?.surgery?.patient?.userId === currentUser.id,
      );
    }
    return payments;
  }

  /**
   * Shared money-movement core for office auto-confirm (T2) and office
   * confirmation (T4, design section 8.2): lock the plan row FOR UPDATE,
   * assert the plan is payable, switch effects by payment type (installment
   * accumulation with the proportional principal credit, or amortization with
   * strategy recalculation persisted in place), re-evaluate the plan
   * lifecycle, confirm the payment and write the in-transaction audit entries.
   */
  private async applyPaymentEffects(
    manager: EntityManager,
    payment: Payment,
    actorId: string,
  ): Promise<void> {
    const plan = await manager.findOne(PaymentPlan, {
      where: { id: payment.paymentPlanId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!plan) throw new NotFoundException('Payment plan not found');
    if (
      plan.status !== PaymentPlanStatus.ACTIVE &&
      plan.status !== PaymentPlanStatus.DELINQUENT
    ) {
      throw new ConflictException('Payment plan is not active');
    }

    let installmentEffect: {
      id: string;
      status: InstallmentStatus;
      paidAmount: string;
    } | null = null;
    let recalcEffect: {
      previous: Record<string, unknown>;
      current: Record<string, unknown>;
    } | null = null;

    if (payment.type === PaymentType.INSTALLMENT_PAYMENT) {
      const installmentId = payment.installmentId;
      if (!installmentId) {
        throw new BadRequestException(
          'installmentId is required for installment payments',
        );
      }
      const installment = await manager.findOne(Installment, {
        where: { id: installmentId },
      });
      if (!installment) throw new NotFoundException('Installment not found');

      const paidAfter = new Decimal(installment.paidAmount).plus(
        payment.amount,
      );
      // Design D1: paid_amount is an accumulator capped by total_amount; an
      // overpayment is a conflict, the explicit path is principal_amortization.
      if (paidAfter.gt(installment.totalAmount)) {
        throw new ConflictException(
          "amount exceeds the installment's remaining balance; use a principal_amortization for extra payments",
        );
      }
      const creditBefore = creditPrincipal(
        installment.principalAmount,
        installment.paidAmount,
        installment.totalAmount,
      );
      installment.paidAmount = paidAfter.toFixed(MONEY_DECIMALS);
      installment.status = paidAfter.eq(installment.totalAmount)
        ? InstallmentStatus.PAID
        : InstallmentStatus.PARTIAL;
      await manager.save(installment);

      const creditAfter = creditPrincipal(
        installment.principalAmount,
        installment.paidAmount,
        installment.totalAmount,
      );
      plan.outstandingBalance = new Decimal(plan.outstandingBalance)
        .minus(creditAfter.minus(creditBefore))
        .toFixed(MONEY_DECIMALS);
      installmentEffect = {
        id: installment.id,
        status: installment.status,
        paidAmount: installment.paidAmount,
      };
    } else if (payment.type === PaymentType.PRINCIPAL_AMORTIZATION) {
      if (new Decimal(payment.amount).gt(plan.outstandingBalance)) {
        throw new ConflictException('amount exceeds the outstanding balance');
      }
      const previousBalance = plan.outstandingBalance;
      // Recalculation only ever rewrites pending lines (design section 7
      // contract: paidAmount is always '0.00'); partial and paid installments
      // keep their locked amounts.
      const pendingInstallments = await manager.find(Installment, {
        where: { paymentPlanId: plan.id, status: InstallmentStatus.PENDING },
        order: { installmentNumber: 'ASC' },
      });
      const previousSchedule = pendingInstallments.map((installment) => ({
        id: installment.id,
        installmentNumber: installment.installmentNumber,
        principalAmount: installment.principalAmount,
        interestAmount: installment.interestAmount,
        totalAmount: installment.totalAmount,
        status: installment.status,
      }));

      plan.outstandingBalance = new Decimal(previousBalance)
        .minus(payment.amount)
        .toFixed(MONEY_DECIMALS);
      const strategy = this.recalculationStrategyFactory.getFor(
        payment.amortizationMode,
      );
      const recalculated = strategy.recalculate({
        outstandingBalance: plan.outstandingBalance,
        monthlyInterestRate: plan.monthlyInterestRate,
        pendingInstallments: pendingInstallments.map((installment) => ({
          id: installment.id,
          installmentNumber: installment.installmentNumber,
          totalAmount: installment.totalAmount,
          paidAmount: installment.paidAmount,
        })),
      });
      // AD6: strategies are pure; persist their returned lines in place.
      for (const line of recalculated) {
        const target = pendingInstallments.find(
          (installment) => installment.id === line.id,
        );
        if (!target) continue;
        target.principalAmount = line.principalAmount;
        target.interestAmount = line.interestAmount;
        target.totalAmount = line.totalAmount;
        target.status = line.status;
        await manager.save(target);
      }
      recalcEffect = {
        previous: {
          outstandingBalance: previousBalance,
          installments: previousSchedule,
        },
        current: {
          outstandingBalance: plan.outstandingBalance,
          installments: recalculated.map((line) => ({
            id: line.id,
            installmentNumber: pendingInstallments.find(
              (installment) => installment.id === line.id,
            )?.installmentNumber,
            principalAmount: line.principalAmount,
            interestAmount: line.interestAmount,
            totalAmount: line.totalAmount,
            status: line.status,
          })),
        },
      };
    }
    // down_payment: no schedule or balance effect (defensive; design 8.2).

    await manager.save(plan);
    await this.evaluatePlanLifecycle(manager, plan);
    payment.status = PaymentStatus.CONFIRMED;
    await manager.save(payment);

    await this.auditService.log(manager, {
      userId: actorId,
      action: AUDIT_ACTION_PAYMENT_CONFIRMED,
      tableName: AUDIT_TABLE_PAYMENTS,
      recordId: payment.id,
      previousData: { status: PaymentStatus.PENDING_CONFIRMATION },
      newData: {
        status: PaymentStatus.CONFIRMED,
        type: payment.type,
        amount: payment.amount,
        installmentId: payment.installmentId,
        amortizationMode: payment.amortizationMode,
        outstandingBalance: plan.outstandingBalance,
        installment: installmentEffect,
      },
    });
    if (recalcEffect) {
      await this.auditService.log(manager, {
        userId: actorId,
        action: AUDIT_ACTION_PLAN_RECALCULATED,
        tableName: AUDIT_TABLE_PAYMENT_PLANS,
        recordId: plan.id,
        previousData: recalcEffect.previous,
        newData: recalcEffect.current,
      });
    }
  }

  /**
   * Design section 8.2 step 5: completed <=> balance 0 AND every
   * non-cancelled installment paid; delinquent <=> NOT completed AND some
   * pending/partial installment is due before CURRENT_DATE (DB date, no
   * client/server drift); otherwise active.
   */
  private async evaluatePlanLifecycle(
    manager: EntityManager,
    plan: PaymentPlan,
  ): Promise<void> {
    const rows: { unpaid: string; overdue: string }[] = await manager.query(
      `SELECT
         (SELECT COUNT(*)::text FROM installments
           WHERE payment_plan_id = $1 AND status <> 'cancelled' AND status <> 'paid') AS unpaid,
         (SELECT COUNT(*)::text FROM installments
           WHERE payment_plan_id = $1 AND status IN ('pending','partial')
             AND due_date < CURRENT_DATE) AS overdue`,
      [plan.id],
    );
    const unpaidCount = Number(rows[0].unpaid);
    const overdueCount = Number(rows[0].overdue);
    if (new Decimal(plan.outstandingBalance).isZero() && unpaidCount === 0) {
      plan.status = PaymentPlanStatus.COMPLETED;
    } else if (overdueCount > 0) {
      plan.status = PaymentPlanStatus.DELINQUENT;
    } else {
      plan.status = PaymentPlanStatus.ACTIVE;
    }
    await manager.save(plan);
  }

  private assertTypeIntegrity(createPaymentDto: CreatePaymentDto): void {
    if (createPaymentDto.type === PaymentType.PRINCIPAL_AMORTIZATION) {
      if (createPaymentDto.installmentId) {
        throw new BadRequestException(
          'principal amortizations cannot reference an installment',
        );
      }
      if (!createPaymentDto.amortizationMode) {
        throw new BadRequestException(
          'amortizationMode is required for principal amortizations',
        );
      }
    } else {
      if (createPaymentDto.amortizationMode) {
        throw new BadRequestException(
          'amortizationMode is only allowed for principal amortizations',
        );
      }
      if (
        createPaymentDto.type === PaymentType.INSTALLMENT_PAYMENT &&
        !createPaymentDto.installmentId
      ) {
        throw new BadRequestException(
          'installmentId is required for installment payments',
        );
      }
      if (
        createPaymentDto.type === PaymentType.DOWN_PAYMENT &&
        createPaymentDto.installmentId
      ) {
        throw new BadRequestException(
          'down payments cannot reference an installment',
        );
      }
    }
  }

  private async assertPatientOwnsPlan(
    manager: EntityManager,
    plan: PaymentPlan,
    currentUser: User,
  ): Promise<void> {
    const ownedPlan = await manager.findOne(PaymentPlan, {
      where: { id: plan.id },
      relations: ['surgery', 'surgery.patient'],
    });
    const ownerUserId = ownedPlan?.surgery?.patient?.userId ?? null;
    if (ownerUserId !== currentUser.id) {
      throw new ForbiddenException(
        'Patients can only register payments for their own plans',
      );
    }
  }

  private isStaff(currentUser: User): boolean {
    return (
      currentUser.role === UserRole.OFFICE ||
      currentUser.role === UserRole.ADMIN
    );
  }
}

/**
 * Design section 8.2: the principal credited by a paid fraction of an
 * installment, HALF_UP to cents. At paid == total it equals the installment
 * principal exactly, so a fully paid plan drives the balance to zero.
 */
function creditPrincipal(
  principalAmount: string,
  paidAmount: string,
  totalAmount: string,
): Decimal {
  return new Decimal(principalAmount)
    .mul(paidAmount)
    .div(totalAmount)
    .toDecimalPlaces(MONEY_DECIMALS, HALF_UP_ROUNDING);
}
