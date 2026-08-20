import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { DispatchStatus } from '../../common/enums';

/**
 * Maps migration 003 `whatsapp_dispatches` (design §5.2) 1:1. The migration
 * DDL owns the schema (uuid PK, dispatch_status enum, send_attempts CHECK
 * 0..3, dedupe_key UNIQUE, queued_has_no_wamid CHECK); this entity only
 * mirrors it for TypeORM access.
 *
 * Timestamps created_at/updated_at stay DB-managed (DEFAULT now()), matching
 * the MessageTemplate entity convention; `sentAt` is entity-mapped because
 * the service writes it after the provider send (design §9.2).
 */
@Entity('whatsapp_dispatches')
export class WhatsAppDispatch {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('uuid', { name: 'patient_id' })
  patientId: string;

  @ApiProperty()
  @Column('uuid', { name: 'template_id' })
  templateId: string;

  @ApiProperty({ enum: DispatchStatus, default: DispatchStatus.QUEUED })
  @Column({
    type: 'enum',
    enum: DispatchStatus,
    default: DispatchStatus.QUEUED,
  })
  status: DispatchStatus;

  @ApiProperty({ default: 0 })
  @Column('smallint', { name: 'send_attempts', default: 0 })
  sendAttempts: number;

  @ApiProperty({ nullable: true })
  @Column('varchar', {
    length: 255,
    name: 'provider_message_id',
    nullable: true,
  })
  providerMessageId: string | null;

  @ApiProperty({ nullable: true })
  @Column('text', { name: 'provider_error', nullable: true })
  providerError: string | null;

  @ApiProperty({ type: Object })
  @Column('jsonb', { name: 'payload', default: {} })
  payload: Record<string, string>;

  @ApiProperty({ example: '+59170000001' })
  @Column('varchar', { length: 50 })
  phone: string;

  @ApiProperty({ nullable: true })
  @Column('text', { name: 'dedupe_key', nullable: true })
  dedupeKey: string | null;

  @ApiProperty({ nullable: true })
  @Column('uuid', { name: 'created_by_user_id', nullable: true })
  createdByUserId: string | null;

  @ApiProperty({ nullable: true })
  @Column('timestamptz', { name: 'sent_at', nullable: true })
  sentAt: Date | null;
}
