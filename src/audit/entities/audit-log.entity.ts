import { ApiProperty } from '@nestjs/swagger';
import { User } from '../../auth/entities/user.entity';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Append-only audit trail (design section 5.12). Rows are never updated or
 * deleted by application code; record_id is polymorphic (NO FK), user_id NULL
 * means a system action (e.g. cron).
 */
@Entity('audit_logs')
export class AuditLog {
  @ApiProperty()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({ nullable: true })
  @Column('uuid', { name: 'user_id', nullable: true })
  userId: string | null;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user?: User | null;

  @ApiProperty()
  @Column('text')
  action: string;

  @ApiProperty()
  @Column('text', { name: 'table_name' })
  tableName: string;

  @ApiProperty({ nullable: true })
  @Column('uuid', { name: 'record_id', nullable: true })
  recordId: string | null;

  @ApiProperty({ nullable: true })
  @Column('jsonb', { name: 'previous_data', nullable: true })
  previousData?: Record<string, unknown> | null;

  @ApiProperty({ nullable: true })
  @Column('jsonb', { name: 'new_data', nullable: true })
  newData?: Record<string, unknown> | null;

  @ApiProperty()
  @Column('timestamptz', { name: 'created_at', default: () => 'now()' })
  createdAt: Date;
}
