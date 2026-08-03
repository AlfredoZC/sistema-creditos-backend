import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('payment_methods')
export class PaymentMethod {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('varchar', { length: 50, unique: true })
  name: string;

  // Disabled methods are hidden from the read side and rejected with 409 when
  // a payment references them (payment-processing spec). The default lives in
  // the migration DDL (is_enabled boolean NOT NULL DEFAULT true).
  @ApiProperty()
  @Column('bool', { name: 'is_enabled', default: true })
  isEnabled: boolean;

  @ApiProperty({ nullable: true })
  @Column('text', { nullable: true })
  description?: string | null;
}
