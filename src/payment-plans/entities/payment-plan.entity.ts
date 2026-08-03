import { ApiProperty } from '@nestjs/swagger';
import { Surgery } from '../../surgeries/entities/surgery.entity';
import { decimalTransformer } from '../../common/transformers';
import {
  PaymentPlanStatus,
  PaymentPlanType,
} from '../../common/enums';
import {
  Column,
  Entity,
  JoinColumn,
  OneToMany,
  OneToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Installment } from './installment.entity';

@Entity('payment_plans')
export class PaymentPlan {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // One plan per surgery (UNIQUE surgery_id in the migration + design 5.8);
  // the OneToOne relation is only for reads, ownership is derived through
  // surgery.patient.user_id.
  @ApiProperty()
  @Column('uuid', { name: 'surgery_id', unique: true })
  surgeryId: string;

  @OneToOne(() => Surgery)
  @JoinColumn({ name: 'surgery_id' })
  surgery?: Surgery;

  @ApiProperty({ enum: PaymentPlanType })
  @Column({ type: 'enum', enum: PaymentPlanType })
  type: PaymentPlanType;

  // Money columns: decimal strings via the shared transformer (design AD2),
  // never JS floats. Defaults live in the migration DDL.
  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    name: 'down_payment',
    transformer: decimalTransformer,
    default: '0.00',
  })
  downPayment: string;

  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    name: 'financed_amount',
    transformer: decimalTransformer,
  })
  financedAmount: string;

  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    name: 'monthly_interest_rate',
    transformer: decimalTransformer,
    default: '2.00',
  })
  monthlyInterestRate: string;

  @ApiProperty()
  @Column('int', { name: 'installment_count' })
  installmentCount: number;

  @ApiProperty()
  @Column('date', { name: 'start_date' })
  startDate: string;

  @ApiProperty()
  @Column('numeric', {
    precision: 10,
    scale: 2,
    name: 'outstanding_balance',
    transformer: decimalTransformer,
  })
  outstandingBalance: string;

  @ApiProperty({ enum: PaymentPlanStatus, default: PaymentPlanStatus.ACTIVE })
  @Column({
    type: 'enum',
    enum: PaymentPlanStatus,
    default: PaymentPlanStatus.ACTIVE,
  })
  status: PaymentPlanStatus;

  @OneToMany(() => Installment, (installment) => installment.plan)
  installments?: Installment[];
}
