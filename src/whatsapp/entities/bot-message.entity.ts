import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { BotDirection } from '../../common/enums';
import type { BotIntent } from '../intent-parser';

/**
 * Maps migration 003 `bot_messages` (design §5.4) 1:1. The migration DDL owns
 * the schema (uuid PK, direction enum, provider_message_id UNIQUE, type
 * 'text'|'template' CHECK — NOT an enum, template_requires_template_type and
 * intent_valid CHECKs); this entity only mirrors it for TypeORM access.
 *
 * `type` is a varchar with a CHECK — deliberately not a TS enum (the 5-enum
 * list is fixed, design §4). `intent` mirrors the bot intent vocabulary
 * ('saldo'|'cuotas'|'proxima') from intent-parser; `metadata` carries only
 * operational send state ({ status: 'pending'|'sent'|'failed', error }).
 */
@Entity('bot_messages')
export class BotMessage {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty()
  @Column('uuid', { name: 'conversation_id' })
  conversationId: string;

  @ApiProperty({ enum: BotDirection })
  @Column({ type: 'enum', enum: BotDirection })
  direction: BotDirection;

  @ApiProperty({ example: 'saldo' })
  @Column('text')
  body: string;

  @ApiProperty({ nullable: true })
  @Column('varchar', { length: 255, name: 'provider_message_id', nullable: true })
  providerMessageId: string | null;

  @ApiProperty({ default: 'text' })
  @Column('varchar', { length: 10, default: 'text' })
  type: 'text' | 'template';

  @ApiProperty({ nullable: true })
  @Column('uuid', { name: 'template_id', nullable: true })
  templateId: string | null;

  @ApiProperty({ nullable: true, enum: ['saldo', 'cuotas', 'proxima'] })
  @Column('varchar', { length: 20, nullable: true })
  intent: BotIntent | null;

  @ApiProperty({ type: Object, default: {} })
  @Column('jsonb', { default: {} })
  metadata: Record<string, unknown>;
}
