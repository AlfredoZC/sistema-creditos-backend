import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { ReminderKind } from '../../common/enums';

/**
 * Espejo del DDL de la migracion 005. `synchronize` esta apagado, asi que
 * estos decoradores documentan la intencion; la fuente de verdad es la
 * migracion.
 */
@Entity('installment_reminders')
@Index('uq_installment_reminders_installment_kind', ['installmentId', 'kind'], {
  unique: true,
})
export class InstallmentReminder {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('uuid', { name: 'installment_id' })
  installmentId: string;

  @ApiProperty({ enum: ReminderKind })
  @Column({
    type: 'enum',
    enum: ReminderKind,
    enumName: 'installment_reminder_kind',
  })
  kind: ReminderKind;

  @ApiProperty({ nullable: true })
  @Column('uuid', { name: 'dispatch_id', nullable: true })
  dispatchId: string | null;

  @ApiProperty()
  @Column('timestamptz', { name: 'sent_at', default: () => 'now()' })
  sentAt: Date;
}
