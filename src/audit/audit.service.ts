import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity';

/**
 * Actions vocabulary (design section 5.12): 'payment_plan.created' |
 * 'payment.confirmed' | 'payment.rejected' | 'payment_plan.recalculated' |
 * 'surgery.status_changed'.
 */
export interface AuditEntryInput {
  /** Actor; null = system action (e.g. cron). */
  userId: string | null;
  action: string;
  tableName: string;
  /** Polymorphic id of the affected row; null when not applicable. */
  recordId: string | null;
  previousData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
}

@Injectable()
export class AuditService {
  /**
   * Writes one audit entry through the caller's EntityManager so it commits
   * or rolls back with the business transaction (AD3: explicit in-transaction
   * logging, no TypeORM subscribers). jsonb payloads are serialized by the
   * driver; undefined fields are normalized to NULL.
   */
  async log(manager: EntityManager, entry: AuditEntryInput): Promise<void> {
    await manager.getRepository(AuditLog).insert({
      userId: entry.userId,
      action: entry.action,
      tableName: entry.tableName,
      recordId: entry.recordId,
      previousData: entry.previousData ?? null,
      newData: entry.newData ?? null,
    });
  }
}
