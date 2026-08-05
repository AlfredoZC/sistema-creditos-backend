import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BotConversationState } from '../../common/enums';

/**
 * Maps migration 003 `bot_conversations` (design §5.3) 1:1. The migration DDL
 * owns the schema (uuid PK, wa_id UNIQUE, state enum, failed_attempts CHECK
 * 0..3, lockout_requires_failures + state_matches_patient CHECKs); this entity
 * only mirrors it for TypeORM access.
 *
 * `waId` stores the CANONICAL normalized phone (+591XXXXXXXX) — the exact
 * indexed lookup key (design §9.4 step 2); the raw caller number is never
 * stored. Timestamps stay DB-managed (DEFAULT now()); `lastActivityAt` is
 * entity-mapped because the bot service updates it per inbound message.
 */
@Entity('bot_conversations')
export class BotConversation {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ example: '+59170000001' })
  @Column('varchar', { length: 50, name: 'wa_id', unique: true })
  waId: string;

  @ApiProperty({ nullable: true })
  @Column('uuid', { name: 'patient_id', nullable: true })
  patientId: string | null;

  @ApiProperty({ enum: BotConversationState, default: BotConversationState.UNIDENTIFIED })
  @Column({
    type: 'enum',
    enum: BotConversationState,
    default: BotConversationState.UNIDENTIFIED,
  })
  state: BotConversationState;

  @ApiProperty({ default: 0 })
  @Column('smallint', { name: 'failed_attempts', default: 0 })
  failedAttempts: number;

  @ApiProperty({ nullable: true })
  @Column('timestamptz', { name: 'lockout_until', nullable: true })
  lockoutUntil: Date | null;

  @ApiProperty()
  @Column('timestamptz', { name: 'last_activity_at' })
  lastActivityAt: Date;

  @ApiProperty()
  @Column('timestamptz', { name: 'started_at' })
  startedAt: Date;

  @ApiProperty({ nullable: true })
  @Column('timestamptz', { name: 'ended_at', nullable: true })
  endedAt: Date | null;
}
