import { INestApplication } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { AuditService } from './audit.service';

jest.setTimeout(60000);

// Shared-db convention: no truncate (audit_logs is append-only by design).
// Every payload carries a per-run marker (pid + timestamp) so assertions
// scope to this run's rows.
const RUN_SUFFIX = `${process.pid}${Date.now()}`;

interface IdRow {
  id: string;
}

interface AuditRow {
  user_id: string | null;
  action: string;
  table_name: string;
  record_id: string | null;
  previous_data: Record<string, unknown> | null;
  new_data: Record<string, unknown> | null;
}

describe('AuditService contract (design section 5.12)', () => {
  describe('unit: entry shape passed to the transactional manager', () => {
    it('maps a full audit entry to the repository insert payload', async () => {
      const insert = jest.fn().mockResolvedValue(undefined);
      const manager = {
        getRepository: () => ({ insert }),
      } as unknown as EntityManager;
      const service = new AuditService();

      await service.log(manager, {
        userId: 'user-123',
        action: 'surgery.status_changed',
        tableName: 'surgeries',
        recordId: 'surgery-456',
        previousData: { status: 'scheduled' },
        newData: { status: 'performed' },
      });

      expect(insert).toHaveBeenCalledWith({
        userId: 'user-123',
        action: 'surgery.status_changed',
        tableName: 'surgeries',
        recordId: 'surgery-456',
        previousData: { status: 'scheduled' },
        newData: { status: 'performed' },
      });
    });

    it('maps a system action without actor or payloads to nulls', async () => {
      const insert = jest.fn().mockResolvedValue(undefined);
      const manager = {
        getRepository: () => ({ insert }),
      } as unknown as EntityManager;
      const service = new AuditService();

      await service.log(manager, {
        userId: null,
        action: 'payment_plan.created',
        tableName: 'payment_plans',
        recordId: null,
      });

      expect(insert).toHaveBeenCalledWith({
        userId: null,
        action: 'payment_plan.created',
        tableName: 'payment_plans',
        recordId: null,
        previousData: null,
        newData: null,
      });
    });
  });

  describe('integration: in-transaction persistence', () => {
    let app: INestApplication;
    let dataSource: DataSource;
    let auditService: AuditService;

    beforeAll(async () => {
      await ensureTestDbReady();
      app = await buildTestingApp();
      dataSource = app.get(DataSource);
      auditService = app.get(AuditService);
    });

    afterAll(async () => {
      await app.close();
    });

    async function insertUserRaw(
      email: string,
      name: string,
      role: string,
    ): Promise<string> {
      const rows: IdRow[] = await dataSource.query(
        `INSERT INTO users (email, password, name, role, is_active)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id`,
        [email, 'hashed-password', name, role],
      );
      return rows[0].id;
    }

    async function auditRowsByMarker(
      marker: string,
    ): Promise<AuditRow[]> {
      return dataSource.query(
        `SELECT user_id, action, table_name, record_id, previous_data, new_data
         FROM audit_logs
         WHERE new_data ->> 'marker' = $1
         ORDER BY created_at`,
        [marker],
      );
    }

    it('persists one row with the full entry when the caller transaction commits', async () => {
      const marker = `commit-${RUN_SUFFIX}`;

      await dataSource.transaction(async (manager) => {
        await auditService.log(manager, {
          userId: null,
          action: 'payment_plan.created',
          tableName: 'payment_plans',
          recordId: null,
          previousData: null,
          newData: { type: 'credit', marker },
        });
      });

      const rows = await auditRowsByMarker(marker);
      expect(rows).toHaveLength(1);
      expect(rows[0].action).toBe('payment_plan.created');
      expect(rows[0].table_name).toBe('payment_plans');
      expect(rows[0].user_id).toBeNull();
      expect(rows[0].record_id).toBeNull();
      expect(rows[0].previous_data).toBeNull();
      expect(rows[0].new_data).toEqual({ type: 'credit', marker });
    });

    it('persists the actor user_id and jsonb payloads round-trip as objects', async () => {
      const marker = `actor-${RUN_SUFFIX}`;
      const actorId = await insertUserRaw(
        `audit.actor.${marker}@example.com`,
        'Audit Actor',
        'office',
      );

      await dataSource.transaction(async (manager) => {
        await auditService.log(manager, {
          userId: actorId,
          action: 'surgery.status_changed',
          tableName: 'surgeries',
          recordId: null,
          previousData: { status: 'scheduled', marker },
          newData: { status: 'performed', marker },
        });
      });

      const rows = await auditRowsByMarker(marker);
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBe(actorId);
      expect(rows[0].previous_data).toEqual({ status: 'scheduled', marker });
      expect(rows[0].new_data).toEqual({ status: 'performed', marker });
    });

    it('rolls the audit row back when the caller transaction rolls back', async () => {
      const marker = `rollback-${RUN_SUFFIX}`;

      await expect(
        dataSource.transaction(async (manager) => {
          await auditService.log(manager, {
            userId: null,
            action: 'payment.rejected',
            tableName: 'payments',
            recordId: null,
            previousData: { status: 'pending_confirmation', marker },
            newData: { status: 'rejected', marker },
          });
          throw new Error('business failure after audit write');
        }),
      ).rejects.toThrow('business failure after audit write');

      const rows = await auditRowsByMarker(marker);
      expect(rows).toHaveLength(0);
    });

    it('rejects a user_id that references a missing user (FK NO ACTION)', async () => {
      const marker = `fk-${RUN_SUFFIX}`;

      await expect(
        dataSource.transaction(async (manager) => {
          await auditService.log(manager, {
            userId: '00000000-0000-4000-8000-000000000000',
            action: 'payment.confirmed',
            tableName: 'payments',
            recordId: null,
            previousData: null,
            newData: { marker },
          });
        }),
      ).rejects.toThrow();
    });

    it('writes a system action (user_id NULL) outside any caller transaction', async () => {
      const marker = `system-${RUN_SUFFIX}`;
      const executor = dataSource.manager;

      await auditService.log(executor, {
        userId: null,
        action: 'payment_plan.recalculated',
        tableName: 'payment_plans',
        recordId: null,
        previousData: { balance: '8155.19', marker },
        newData: { balance: '7041.92', marker },
      });

      const rows = await auditRowsByMarker(marker);
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBeNull();
      expect(rows[0].previous_data).toEqual({ balance: '8155.19', marker });
      expect(rows[0].new_data).toEqual({ balance: '7041.92', marker });
    });
  });
});
