import { ApiProperty } from '@nestjs/swagger';
import { decimalTransformer } from '../../common/transformers';
import { InstallmentStatus } from '../../common/enums';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PaymentPlan } from './payment-plan.entity';

@Entity('installments')
// Mirror of the migration DDL (design 5.9): one row per (plan, number) and the
// due-date/status index used by the reminder cron. synchronize is off, so these
// decorators document intent only.
@Index('uq_installments_plan_number', ['paymentPlanId', 'installmentNumber'], {
  unique: true,
})
@Index('idx_installments_due_date_status', ['dueDate', 'status'])
export class Installment {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('uuid', { name: 'payment_plan_id' })
  paymentPlanId: string;

  @ManyToOne(() => PaymentPlan, (plan) => plan.installments)
  @JoinColumn({ name: 'payment_plan_id' })
  plan?: PaymentPlan;

  @ApiProperty()
  @Column('int', { name: 'installment_number' })
  installmentNumber: number;

  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    name: 'principal_amount',
    transformer: decimalTransformer,
  })
  principalAmount: string;

  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    name: 'interest_amount',
    transformer: decimalTransformer,
    default: '0.00',
  })
  interestAmount: string;

  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    name: 'total_amount',
    transformer: decimalTransformer,
  })
  totalAmount: string;

  // Accumulator driven by confirmed payments (design D1); the migration CHECK
  // guarantees paid_amount <= total_amount.
  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    name: 'paid_amount',
    transformer: decimalTransformer,
    default: '0.00',
  })
  paidAmount: string;

  @ApiProperty()
  @Column('date', { name: 'due_date' })
  dueDate: string;

  @ApiProperty({ enum: InstallmentStatus, default: InstallmentStatus.PENDING })
  @Column({
    type: 'enum',
    enum: InstallmentStatus,
    default: InstallmentStatus.PENDING,
  })
  status: InstallmentStatus;
}
