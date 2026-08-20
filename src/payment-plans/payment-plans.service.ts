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
import {
  DataSource,
  EntityManager,
  FindOptionsWhere,
  In,
  Repository,
} from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { User } from '../auth/entities/user.entity';
import {
  InstallmentStatus,
  PaymentPlanStatus,
  PaymentPlanType,
  PaymentStatus,
  PaymentType,
  UserRole,
} from '../common/enums';
import { handleDatabaseError } from '../common/errors';
import { PaymentMethod } from '../payment-methods/entities/payment-method.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Surgery } from '../surgeries/entities/surgery.entity';
import { CreatePaymentPlanDto, PaymentPlanQueryDto } from './dto';
import { Installment, PaymentPlan } from './entities';
import { FinancingEngine } from './financing/financing-engine';
import { RecalculationStrategyFactory } from './strategies';

const MONEY_DECIMALS = 2;
const HALF_UP_ROUNDING = Decimal.ROUND_HALF_UP;
const AUDIT_ACTION_PLAN_CREATED = 'payment_plan.created';
const AUDIT_TABLE_PAYMENT_PLANS = 'payment_plans';
const DEFAULT_MONTHLY_INTEREST_RATE = '2.00';
const DEFAULT_DOWN_PAYMENT = '0.00';

export interface InstallmentRead {
  id: string;
  paymentPlanId: string;
  installmentNumber: number;
  principalAmount: string;
  interestAmount: string;
  totalAmount: string;
  paidAmount: string;
  dueDate: string;
  status: InstallmentStatus;
  // Derived read-only flag (design section 11): due before today AND still
  // pending/partial. Never a write.
  overdue: boolean;
}

/**
 * Patient-scoped debt summary (design section 10, D4) — consumed server-side
 * by the WhatsApp bot for identified conversations. Service-only: never a
 * route of any kind. Money fields are decimal strings, never JS floats.
 */
export interface PatientDebtSummary {
  outstandingBalance: string;
  nextDueInstallment: {
    installmentNumber: number;
    totalAmount: string;
    dueDate: string;
  } | null;
  overdueTotal: string;
}

/**
 * T1 (design section 8.1): plan creation runs in ONE transaction — plan row,
 * full installment schedule, the auto-confirmed down-payment payment, and the
 * audit entry all commit or roll back together. The RecalculationStrategyFactory
 * is wired as a provider now; confirmation-time recalculation (which consumes
 * it) lands with the payments module in PR13.
 */
@Injectable()
export class PaymentPlansService {
  constructor(
    @InjectRepository(PaymentPlan)
    private readonly paymentPlanRepository: Repository<PaymentPlan>,
    @InjectRepository(Installment)
    private readonly installmentRepository: Repository<Installment>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    private readonly financingEngine: FinancingEngine,
    private readonly recalculationStrategyFactory: RecalculationStrategyFactory,
  ) {}

  async create(
    createPaymentPlanDto: CreatePaymentPlanDto,
    currentUser: User,
  ): Promise<PaymentPlan> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const surgery = await manager.findOne(Surgery, {
          where: { id: createPaymentPlanDto.surgeryId },
        });
        if (!surgery) throw new NotFoundException('Surgery not found');

        const existingPlan = await manager.findOne(PaymentPlan, {
          where: { surgeryId: surgery.id },
        });
        if (existingPlan) {
          throw new ConflictException(
            'A payment plan already exists for this surgery',
          );
        }

        const downPayment =
          createPaymentPlanDto.downPayment ?? DEFAULT_DOWN_PAYMENT;
        const financedAmount = this.computeFinancedAmount(
          surgery.totalCost,
          downPayment,
        );

        const isUpfront = createPaymentPlanDto.type === PaymentPlanType.UPFRONT;
        // Upfront plans are pinned to one installment at zero interest
        // (spec "French Amortization Schedule Generation"); credit plans need
        // an explicit installment count.
        const installmentCount = isUpfront
          ? 1
          : createPaymentPlanDto.installmentCount;
        if (!isUpfront && installmentCount === undefined) {
          throw new BadRequestException(
            'installmentCount is required for credit plans',
          );
        }
        const monthlyInterestRate = isUpfront
          ? '0.00'
          : (createPaymentPlanDto.monthlyInterestRate ??
            DEFAULT_MONTHLY_INTEREST_RATE);

        // Normalize any valid ISO input (IsDateString) to a clean 'YYYY-MM-DD'
        // so the value always fits the PG date column regardless of format.
        const startDate = createPaymentPlanDto.startDate
          ? toUtcDateString(parseUtcDate(createPaymentPlanDto.startDate))
          : todayUtcDateString();
        const schedule =
          this.financingEngine.generateFrenchAmortizationSchedule(
            financedAmount,
            monthlyInterestRate,
            installmentCount,
            parseUtcDate(startDate),
          );

        const plan = manager.create(PaymentPlan, {
          surgeryId: surgery.id,
          type: createPaymentPlanDto.type,
          downPayment,
          financedAmount,
          monthlyInterestRate,
          installmentCount,
          startDate,
          outstandingBalance: financedAmount,
          status: PaymentPlanStatus.ACTIVE,
        });
        const savedPlan = await manager.save(plan);

        const installments = schedule.map((line) =>
          manager.create(Installment, {
            paymentPlanId: savedPlan.id,
            installmentNumber: line.installmentNumber,
            principalAmount: line.principalAmount,
            interestAmount: line.interestAmount,
            totalAmount: line.totalAmount,
            paidAmount: '0.00',
            dueDate: toUtcDateString(line.dueDate),
            status: InstallmentStatus.PENDING,
          }),
        );
        await manager.save(installments);

        // The method check runs AFTER the plan and installments are written so
        // a 404/409 here proves the whole transaction rolls back (no partial
        // plan, installments, payment or audit residue).
        if (new Decimal(downPayment).gt(0)) {
          await this.registerDownPayment(
            manager,
            savedPlan.id,
            downPayment,
            createPaymentPlanDto.paymentMethodId,
            currentUser.id,
          );
        }

        await this.auditService.log(manager, {
          userId: currentUser.id,
          action: AUDIT_ACTION_PLAN_CREATED,
          tableName: AUDIT_TABLE_PAYMENT_PLANS,
          recordId: savedPlan.id,
          newData: {
            type: savedPlan.type,
            downPayment,
            financedAmount,
            monthlyInterestRate,
            installmentCount,
            startDate,
            outstandingBalance: financedAmount,
            status: PaymentPlanStatus.ACTIVE,
            installments: schedule.map((line) => ({
              installmentNumber: line.installmentNumber,
              principalAmount: line.principalAmount,
              interestAmount: line.interestAmount,
              totalAmount: line.totalAmount,
              dueDate: toUtcDateString(line.dueDate),
            })),
          },
        });

        return savedPlan;
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  /**
   * Read side (design section 11): office/admin may read any plan; a patient
   * only the plan of their own surgery (surgery.patient.user_id == actor).
   */
  /**
   * AD8/AD9 (design section 5): staff get the full paginated list, filtered
   * by patientId/surgeryId/status; anyone else (patients AND doctors) gets
   * the load-all-then-filter scope mirroring payments.findAll — only plans
   * whose surgery.patient.userId is the caller's, paginated AFTER the
   * in-memory filter so total is exact. Installments are never embedded
   * (the list is the findOne summary shape).
   */
  async findAll(
    query: PaymentPlanQueryDto,
    currentUser: User,
  ): Promise<{
    data: PaymentPlan[];
    total: number;
    limit: number;
    offset: number;
  }> {
    const { limit = 10, offset = 0 } = query;
    if (this.isStaff(currentUser)) {
      const where: FindOptionsWhere<PaymentPlan> = {};
      if (query.patientId) where.surgery = { patientId: query.patientId };
      if (query.surgeryId) where.surgeryId = query.surgeryId;
      if (query.status) where.status = query.status;
      const [data, total] = await this.paymentPlanRepository.findAndCount({
        where,
        relations: ['surgery', 'surgery.patient', 'surgery.surgeryCatalog'],
        order: { startDate: 'DESC' },
        take: limit,
        skip: offset,
      });
      return { data, total, limit, offset };
    }
    const plans = await this.paymentPlanRepository.find({
      relations: ['surgery', 'surgery.patient', 'surgery.surgeryCatalog'],
      order: { startDate: 'DESC' },
    });
    const owned = plans.filter(
      (plan) => plan.surgery?.patient?.userId === currentUser.id,
    );
    return {
      data: owned.slice(offset, offset + limit),
      total: owned.length,
      limit,
      offset,
    };
  }

  async findOne(id: string, currentUser: User): Promise<PaymentPlan> {
    const plan = await this.paymentPlanRepository.findOne({
      where: { id },
      relations: ['surgery', 'surgery.patient'],
    });
    if (!plan) throw new NotFoundException('Payment plan not found');
    this.assertPatientOwnsPlanOrStaff(plan, currentUser);
    return plan;
  }

  async findInstallments(
    id: string,
    currentUser: User,
  ): Promise<InstallmentRead[]> {
    const plan = await this.paymentPlanRepository.findOne({
      where: { id },
      relations: ['surgery', 'surgery.patient'],
    });
    if (!plan) throw new NotFoundException('Payment plan not found');
    this.assertPatientOwnsPlanOrStaff(plan, currentUser);

    const installments = await this.installmentRepository.find({
      where: { paymentPlanId: id },
      order: { installmentNumber: 'ASC' },
    });
    const today = todayUtcDateString();
    return installments.map((installment) => ({
      id: installment.id,
      paymentPlanId: installment.paymentPlanId,
      installmentNumber: installment.installmentNumber,
      principalAmount: installment.principalAmount,
      interestAmount: installment.interestAmount,
      totalAmount: installment.totalAmount,
      paidAmount: installment.paidAmount,
      dueDate: installment.dueDate,
      status: installment.status,
      overdue: isOverdue(installment.dueDate, today, installment.status),
    }));
  }

  /**
   * Patient-scoped debt read (design section 10, D4): the latest
   * active|delinquent plan of the patient's surgery (only non-completed/
   * non-cancelled plans carry debt), the earliest future non-cancelled
   * pending|partial installment as next due, and the overdue total derived at
   * read time (pending|partial with due_date < today, HALF_UP to cents).
   * outstandingBalance is the plan's tracked column — never recomputed.
   * No plan -> zero summary ('0.00', null, '0.00').
   */
  async getPatientDebtSummary(patientId: string): Promise<PatientDebtSummary> {
    const plan = await this.paymentPlanRepository.findOne({
      where: {
        status: In([PaymentPlanStatus.ACTIVE, PaymentPlanStatus.DELINQUENT]),
        surgery: { patientId },
      },
      order: { startDate: 'DESC' },
    });
    if (!plan) {
      return {
        outstandingBalance: '0.00',
        nextDueInstallment: null,
        overdueTotal: '0.00',
      };
    }

    const installments = await this.installmentRepository.find({
      where: { paymentPlanId: plan.id },
    });
    const today = todayUtcDateString();

    // Earliest (due_date ASC, then installment_number ASC) non-cancelled
    // pending|partial installment still due today or later.
    const dueCandidates = installments
      .filter(
        (installment) =>
          isUnpaid(installment.status) && installment.dueDate >= today,
      )
      .sort((a, b) =>
        a.dueDate === b.dueDate
          ? a.installmentNumber - b.installmentNumber
          : a.dueDate < b.dueDate
            ? -1
            : 1,
      );
    const nextDue = dueCandidates[0];
    const nextDueInstallment = nextDue
      ? {
          installmentNumber: nextDue.installmentNumber,
          totalAmount: nextDue.totalAmount,
          dueDate: nextDue.dueDate,
        }
      : null;

    const overdueTotal = installments
      .filter((installment) =>
        isOverdue(installment.dueDate, today, installment.status),
      )
      .reduce(
        (sum, installment) =>
          sum.plus(
            new Decimal(installment.totalAmount).minus(
              new Decimal(installment.paidAmount),
            ),
          ),
        new Decimal(0),
      )
      .toFixed(MONEY_DECIMALS, HALF_UP_ROUNDING);

    return {
      outstandingBalance: plan.outstandingBalance,
      nextDueInstallment,
      overdueTotal,
    };
  }

  private async registerDownPayment(
    manager: EntityManager,
    paymentPlanId: string,
    downPayment: string,
    paymentMethodId: string | undefined,
    recordedByUserId: string,
  ): Promise<void> {
    if (!paymentMethodId) {
      throw new BadRequestException(
        'paymentMethodId is required when a down payment is provided',
      );
    }
    const paymentMethod = await manager.findOne(PaymentMethod, {
      where: { id: paymentMethodId },
    });
    if (!paymentMethod) throw new NotFoundException('Payment method not found');
    if (!paymentMethod.isEnabled) {
      throw new ConflictException('Payment method is disabled');
    }
    await manager.save(
      manager.create(Payment, {
        paymentPlanId,
        installmentId: null,
        patientUserId: null,
        recordedByUserId,
        paymentMethodId: paymentMethod.id,
        amount: downPayment,
        type: PaymentType.DOWN_PAYMENT,
        amortizationMode: null,
        receiptUrl: null,
        status: PaymentStatus.CONFIRMED,
      }),
    );
  }

  private computeFinancedAmount(
    totalCost: string,
    downPayment: string,
  ): string {
    const financedAmount = new Decimal(totalCost).minus(
      new Decimal(downPayment),
    );
    if (financedAmount.lte(0)) {
      throw new BadRequestException(
        'down payment must be less than the surgery total cost',
      );
    }
    return financedAmount.toFixed(MONEY_DECIMALS);
  }

  private assertPatientOwnsPlanOrStaff(
    plan: PaymentPlan,
    currentUser: User,
  ): void {
    if (currentUser.role === UserRole.PATIENT) {
      const ownerUserId = plan.surgery?.patient?.userId ?? null;
      if (ownerUserId !== currentUser.id) {
        throw new ForbiddenException(
          'Patients can only access their own payment plans',
        );
      }
    }
  }

  private isStaff(currentUser: User): boolean {
    return (
      currentUser.role === UserRole.OFFICE ||
      currentUser.role === UserRole.ADMIN
    );
  }
}

function todayUtcDateString(): string {
  return toUtcDateString(new Date());
}

/**
 * Formats a Date to 'YYYY-MM-DD' on UTC parts. The financing engine computes
 * due dates as UTC-midnight Dates, and date columns are stored as strings in
 * this codebase (same convention as surgeries.scheduled_date) to avoid any
 * timezone shift when the driver serializes a Date back to the DB.
 */
function toUtcDateString(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Parses a 'YYYY-MM-DD' (or full ISO) string as a date; UTC-safe. */
function parseUtcDate(dateString: string): Date {
  return new Date(
    dateString.includes('T') ? dateString : `${dateString}T00:00:00.000Z`,
  );
}

/**
 * Read-only overdue derivation (design section 11): `due_date < today` AND
 * status in (pending, partial). Paid, cancelled and future rows are never
 * overdue.
 */
function isOverdue(
  dueDate: string | Date,
  today: string,
  status: InstallmentStatus,
): boolean {
  if (
    status !== InstallmentStatus.PENDING &&
    status !== InstallmentStatus.PARTIAL
  ) {
    return false;
  }
  const dueDateString =
    dueDate instanceof Date ? toUtcDateString(dueDate) : dueDate;
  return dueDateString < today;
}

/** True for the unpaid statuses that still carry debt (pending, partial). */
function isUnpaid(status: InstallmentStatus): boolean {
  return (
    status === InstallmentStatus.PENDING || status === InstallmentStatus.PARTIAL
  );
}
