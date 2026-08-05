import { ApiProperty } from '@nestjs/swagger';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { TemplateCategory, TemplateStatus } from '../../common/enums';

/**
 * Maps migration 003 `message_templates` (design §5.1) 1:1. The migration DDL
 * owns the schema (uuid PK, name+language UNIQUE, enum columns, jsonb samples,
 * body non-empty CHECK); this entity only mirrors it for TypeORM access.
 * Timestamps stay DB-managed (DEFAULT now()), matching the PaymentPlan entity
 * convention.
 */
@Entity('message_templates')
export class MessageTemplate {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ example: 'payment_reminder' })
  @Column('varchar', { length: 100 })
  name: string;

  @ApiProperty({ enum: TemplateCategory })
  @Column({ type: 'enum', enum: TemplateCategory })
  category: TemplateCategory;

  @ApiProperty({ example: 'es' })
  @Column('varchar', { length: 10, default: 'es' })
  language: string;

  @ApiProperty({ example: 'Your payment of {{1}} is due on {{2}}.' })
  @Column('text', { name: 'body_template' })
  bodyTemplate: string;

  @ApiProperty({ type: Object })
  @Column('jsonb', { name: 'sample_variables', default: {} })
  sampleVariables: Record<string, string>;

  @ApiProperty({ enum: TemplateStatus, default: TemplateStatus.DRAFT })
  @Column({ type: 'enum', enum: TemplateStatus, default: TemplateStatus.DRAFT })
  status: TemplateStatus;

  @ApiProperty({ nullable: true })
  @Column('varchar', {
    length: 255,
    name: 'provider_template_id',
    nullable: true,
  })
  providerTemplateId: string | null;

  @ApiProperty({ nullable: true })
  @Column('varchar', { length: 50, name: 'provider_status', nullable: true })
  providerStatus: string | null;

  @ApiProperty({ default: true })
  @Column('boolean', { name: 'is_active', default: true })
  isActive: boolean;

  @ApiProperty({ nullable: true })
  @Column('uuid', { name: 'created_by_user_id', nullable: true })
  createdByUserId: string | null;

  /**
   * Derived approval gate (design §9.1): non-utility templates (marketing,
   * authentication) require Meta approval before they can be dispatched;
   * utility templates do not. Not a column — computed from `category`.
   */
  get approvalRequired(): boolean {
    return this.category !== TemplateCategory.UTILITY;
  }
}
