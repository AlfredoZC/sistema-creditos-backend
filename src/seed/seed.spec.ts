import { DataSource } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { Profile } from '../profile/entities/profile.entity';
import {
  createMigrationTestDataSource,
  ensureFreshMigrationTestDatabase,
} from '../test-utils/migration-test-db';
import { SeedService } from './seed.service';

jest.setTimeout(120000);

// Dedicated database: the seed wipe (TRUNCATE users, profiles, ...) is
// destructive, so this spec never touches the shared db_creditos_test.
const SEED_TEST_DATABASE = 'db_creditos_seed_test';

interface RoleCountRow {
  role: string;
  count: number;
}

interface CountRow {
  count: number;
}

describe('seed (whole-system demo data, design section 9)', () => {
  let dataSource: DataSource;
  let seedService: SeedService;

  beforeAll(async () => {
    await ensureFreshMigrationTestDatabase(SEED_TEST_DATABASE);
    // The shared migration-test helper registers no entities; SeedService
    // uses the User/Profile metadata (other tables go through raw inserts),
    // so extend its options locally.
    dataSource = new DataSource({
      ...createMigrationTestDataSource(SEED_TEST_DATABASE).options,
      entities: [User, Profile],
    });
    await dataSource.initialize();
    seedService = new SeedService(dataSource.getRepository(User), dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  async function countRowsIn(table: string): Promise<number> {
    const rows: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM ${table}`,
    );
    return rows[0].count;
  }

  it('seeds every business table with deterministic demo data', async () => {
    const result = await seedService.runSeed();
    expect(result).toBe('SEED EXECUTED');

    // Users: the classic one-admin/office/doctor/patient mix, untouched.
    const roleRows: RoleCountRow[] = await dataSource.query(
      'SELECT role, COUNT(*)::int AS count FROM users GROUP BY role ORDER BY role',
    );
    expect(
      Object.fromEntries(roleRows.map((row) => [row.role, row.count])),
    ).toEqual({ admin: 1, doctor: 3, office: 3, patient: 3 });

    // Pinned row counts across the whole system.
    expect(await countRowsIn('users')).toBe(10);
    // One profile per user (6 explicit seed profiles + 4 default-generated
    // for the users without an explicit entry — mirrors auth.create()).
    expect(await countRowsIn('profiles')).toBe(10);
    expect(await countRowsIn('patients')).toBe(6);
    expect(await countRowsIn('doctors')).toBe(3);

    // Every user is linked to a profile — no orphaned accounts.
    const orphanedUsers: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM users
       WHERE "profileId" IS NULL`,
    );
    expect(orphanedUsers[0].count).toBe(0);

    // Doctor profile rows: the 3 phones equal the +59171000001..003 doctor
    // series (disjoint from the patients' +59170000001..06 series — shared
    // database, unique phone constraint).
    const doctorPhones: Array<{ phone: string }> = await dataSource.query(
      'SELECT phone FROM doctors ORDER BY phone',
    );
    expect(doctorPhones.map((row) => row.phone)).toEqual([
      '+59171000001',
      '+59171000002',
      '+59171000003',
    ]);
    const patientPhones: Array<{ phone: string }> = await dataSource.query(
      'SELECT phone FROM patients',
    );
    const doctorPhoneSet = new Set(doctorPhones.map((row) => row.phone));
    expect(
      patientPhones.filter((row) => doctorPhoneSet.has(row.phone)),
    ).toEqual([]);
    expect(await countRowsIn('surgery_catalog')).toBe(5);
    expect(await countRowsIn('surgeries')).toBe(6);
    expect(await countRowsIn('surgery_doctors')).toBe(15);
    expect(await countRowsIn('payment_plans')).toBe(6);
    expect(await countRowsIn('installments')).toBe(48);
    expect(await countRowsIn('payments')).toBe(11);
    expect(await countRowsIn('audit_logs')).toBe(12);
    expect(await countRowsIn('message_templates')).toBe(5);
    expect(await countRowsIn('whatsapp_dispatches')).toBe(6);
    expect(await countRowsIn('bot_conversations')).toBe(5);
    expect(await countRowsIn('bot_messages')).toBe(10);

    // Exactly one principal surgeon per surgery (partial unique index).
    const principals: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM surgery_doctors WHERE role = 'principal'`,
    );
    expect(principals[0].count).toBe(6);

    // French schedule invariant: every plan's installments sum exactly to its
    // financed_amount (last line absorbs the rounding remainder).
    const scheduleMismatches: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payment_plans p
       WHERE p.financed_amount <> (
         SELECT SUM(i.principal_amount)::numeric(10,2) FROM installments i
         WHERE i.payment_plan_id = p.id
       )`,
    );
    expect(scheduleMismatches[0].count).toBe(0);

    // Upfront plans: one installment, zero rate, zero interest.
    const upfrontPlans: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payment_plans WHERE type = 'upfront'`,
    );
    expect(upfrontPlans[0].count).toBe(2);
    const malformedUpfront: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payment_plans
       WHERE type = 'upfront' AND (installment_count <> 1 OR monthly_interest_rate <> '0.00')`,
    );
    expect(malformedUpfront[0].count).toBe(0);
    const upfrontWithInterest: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM installments i
       JOIN payment_plans p ON p.id = i.payment_plan_id
       WHERE p.type = 'upfront' AND i.interest_amount <> '0.00'`,
    );
    expect(upfrontWithInterest[0].count).toBe(0);

    // Credit plans always finance a strictly positive remainder.
    const nonPositiveFinanced: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payment_plans
       WHERE type = 'credit' AND financed_amount <= 0`,
    );
    expect(nonPositiveFinanced[0].count).toBe(0);

    // Installment lifecycle states are exercised.
    const paidInstallments: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM installments WHERE status = 'paid'`,
    );
    expect(paidInstallments[0].count).toBe(3);
    const partialInstallments: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM installments WHERE status = 'partial'`,
    );
    expect(partialInstallments[0].count).toBe(1);
    const cancelledInstallments: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM installments WHERE status = 'cancelled'`,
    );
    expect(cancelledInstallments[0].count).toBe(1);

    // Payments cover all three types and a status mix.
    const downPayments: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payments WHERE type = 'down_payment'`,
    );
    expect(downPayments[0].count).toBe(4);
    const installmentPayments: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payments WHERE type = 'installment_payment'`,
    );
    expect(installmentPayments[0].count).toBe(6);
    const amortizations: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payments WHERE type = 'principal_amortization'`,
    );
    expect(amortizations[0].count).toBe(1);
    const pendingPayments: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payments WHERE status = 'pending_confirmation'`,
    );
    expect(pendingPayments[0].count).toBe(1);
    const rejectedPayments: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM payments WHERE status = 'rejected'`,
    );
    expect(rejectedPayments[0].count).toBe(1);

    // Queued dispatches must never carry a provider_message_id (CHECK).
    const queuedDispatches: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM whatsapp_dispatches WHERE status = 'queued'`,
    );
    expect(queuedDispatches[0].count).toBe(2);
    const queuedWithMessageId: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM whatsapp_dispatches
       WHERE status = 'queued' AND provider_message_id IS NOT NULL`,
    );
    expect(queuedWithMessageId[0].count).toBe(0);

    // Message templates cover the approval lifecycle.
    const approvedUtility: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM message_templates
       WHERE category = 'utility' AND status = 'approved' AND is_active = true`,
    );
    // payment_reminder + payment_overdue: las dos que usa el job diario.
    expect(approvedUtility[0].count).toBe(2);
    const drafts: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM message_templates WHERE status = 'draft'`,
    );
    expect(drafts[0].count).toBe(1);
    const submitted: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM message_templates WHERE status = 'submitted'`,
    );
    expect(submitted[0].count).toBe(1);

    // Identified bot conversations must reference a patient.
    const identifiedConversations: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM bot_conversations WHERE state = 'identified'`,
    );
    expect(identifiedConversations[0].count).toBe(2);
    const unlockedLockout: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM bot_conversations
       WHERE lockout_until IS NULL AND failed_attempts < 3`,
    );
    expect(unlockedLockout[0].count).toBe(4);
  });

  it('wipes existing rows FK-safely and reseeds idempotently', async () => {
    // Precondition: leftover rows from a manual insert must be wiped too.
    const profileRows: { id: number }[] = await dataSource.query(
      `INSERT INTO profiles (gender) VALUES ('No especificado') RETURNING id`,
    );
    await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active, "profileId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        'leftover.user@example.com',
        'hashed',
        'Leftover',
        'patient',
        true,
        profileRows[0].id,
      ],
    );

    await seedService.runSeed();

    // The leftover rows are gone and the deterministic seed totals are stable.
    const userRows: CountRow[] = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM users',
    );
    expect(userRows[0].count).toBe(10);

    const wipedProfileRows: CountRow[] = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM profiles',
    );
    expect(wipedProfileRows[0].count).toBe(10);

    const leftoverUsers: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::int AS count FROM users WHERE email = 'leftover.user@example.com'`,
    );
    expect(leftoverUsers[0].count).toBe(0);

    // payment_methods survives the wipe (migration-owned fixture seed).
    const methodRows: CountRow[] = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM payment_methods',
    );
    expect(methodRows[0].count).toBe(4);

    // Every other table shows the same totals as the first seed run.
    expect(await countRowsIn('patients')).toBe(6);
    expect(await countRowsIn('surgeries')).toBe(6);
    expect(await countRowsIn('installments')).toBe(48);
    expect(await countRowsIn('payments')).toBe(11);
    expect(await countRowsIn('whatsapp_dispatches')).toBe(6);
    expect(await countRowsIn('bot_messages')).toBe(10);
  });
});
