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

describe('seed (single-role users, design section 9)', () => {
  let dataSource: DataSource;
  let seedService: SeedService;

  beforeAll(async () => {
    await ensureFreshMigrationTestDatabase(SEED_TEST_DATABASE);
    // The shared migration-test helper registers no entities; SeedService
    // needs the User/Profile metadata, so extend its options locally.
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

  it('seeds one admin plus a patient/doctor/office mix on the migrated schema', async () => {
    await seedService.runSeed();

    const rows: RoleCountRow[] = await dataSource.query(
      'SELECT role, COUNT(*)::int AS count FROM users GROUP BY role ORDER BY role',
    );
    const countByRole = Object.fromEntries(
      rows.map((row) => [row.role, row.count]),
    );
    expect(countByRole).toEqual({ admin: 1, doctor: 3, office: 3, patient: 3 });
  });

  it('wipes existing users and profiles FK-safely and reseeds idempotently', async () => {
    // Precondition: leftover rows from a manual insert must be wiped too.
    const profileRows: { id: number }[] = await dataSource.query(
      `INSERT INTO profiles (gender) VALUES ('No especificado') RETURNING id`,
    );
    await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active, "profileId")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['leftover.user@example.com', 'hashed', 'Leftover', 'patient', true, profileRows[0].id],
    );

    await seedService.runSeed();

    const userRows: CountRow[] = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM users',
    );
    expect(userRows[0].count).toBe(10);

    const wipedProfileRows: CountRow[] = await dataSource.query(
      'SELECT COUNT(*)::int AS count FROM profiles',
    );
    expect(wipedProfileRows[0].count).toBe(0);
  });
});
