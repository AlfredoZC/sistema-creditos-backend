import { ApiProperty } from '@nestjs/swagger';
import { AmortizationMode } from '../../common/enums';
import { decimalTransformer } from '../../common/transformers';
import {
  PaymentStatus,
  PaymentType,
} from '../../common/enums';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PaymentPlan } from '../../payment-plans/entities/payment-plan.entity';

/**
 * Down-payment row inserted by the plan-creation transaction (design AD4):
 * payment-plans writes the auto-confirmed down_payment payment through this
 * entity without importing the payments module. The full payments module
 * (controller/service/DTO, T2-T5) lands in PR13.
 */
@Entity('payments')
@Index('idx_payments_payment_plan_id', ['paymentPlanId'])
@Index('idx_payments_installment_id', ['installmentId'])
@Index('idx_payments_recorded_by_user_id', ['recordedByUserId'])
export class Payment {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('uuid', { name: 'payment_plan_id' })
  paymentPlanId: string;

  @ManyToOne(() => PaymentPlan)
  @JoinColumn({ name: 'payment_plan_id' })
  paymentPlan?: PaymentPlan;

  // NULL for down payments and principal amortizations (migration CHECK).
  @ApiProperty({ nullable: true })
  @Column('uuid', { name: 'installment_id', nullable: true })
  installmentId: string | null;

  // The patient's own user on receipt upload; NULL for office-recorded rows.
  @ApiProperty({ nullable: true })
  @Column('uuid', { name: 'patient_user_id', nullable: true })
  patientUserId: string | null;

  @ApiProperty()
  @Column('uuid', { name: 'recorded_by_user_id' })
  recordedByUserId: string;

  @ApiProperty()
  @Column('uuid', { name: 'payment_method_id' })
  paymentMethodId: string;

  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    transformer: decimalTransformer,
  })
  amount: string;

  @ApiProperty({ enum: PaymentType })
  @Column({ type: 'enum', enum: PaymentType })
  type: PaymentType;

  // XOR with payment_type (migration CHECK): only principal amortizations
  // carry a mode, every other type keeps NULL.
  @ApiProperty({ enum: AmortizationMode, nullable: true })
  @Column({
    type: 'enum',
    enum: AmortizationMode,
    name: 'amortization_mode',
    nullable: true,
  })
  amortizationMode: AmortizationMode | null;

  @ApiProperty()
  @Column('timestamptz', { name: 'paid_at', default: () => 'now()' })
  paidAt: Date;

  @ApiProperty({ nullable: true })
  @Column('text', { name: 'receipt_url', nullable: true })
  receiptUrl: string | null;

  @ApiProperty({ enum: PaymentStatus, default: PaymentStatus.PENDING_CONFIRMATION })
  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING_CONFIRMATION,
  })
  status: PaymentStatus;
}
