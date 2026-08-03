import { DataSource } from 'typeorm';
import {
  AUTH_MIGRATION_TEST_DATABASE,
  createMigrationTestDataSource,
  ensureFreshMigrationTestDatabase,
} from '../../test-utils/migration-test-db';

jest.setTimeout(120000);

interface UserRow {
  email: string;
  role: string;
}

interface LegacyUserRow {
  email: string;
  roles: string[];
  lastName: string;
}

describe('auth single-role migration (design sections 9 and 10)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    await ensureFreshMigrationTestDatabase(AUTH_MIGRATION_TEST_DATABASE);
    dataSource = createMigrationTestDataSource(AUTH_MIGRATION_TEST_DATABASE);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('migrates a fresh database cleanly from Init with no users', async () => {
    const applied: { count: number }[] = await dataSource.query(
      `SELECT count(*)::int AS count FROM migrations`,
    );
    expect(applied[0].count).toBe(3);

    const users: { count: number }[] = await dataSource.query(
      `SELECT count(*)::int AS count FROM users`,
    );
    expect(users[0].count).toBe(0);
  });

  it('creates the user_role enum with the design-ordered values', async () => {
    const rows: { enumlabel: string }[] = await dataSource.query(
      `SELECT e.enumlabel
         FROM pg_type t
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE t.typname = $1
        ORDER BY e.enumsortorder`,
      ['user_role'],
    );
    expect(rows.map((row) => row.enumlabel)).toEqual([
      'patient',
      'doctor',
      'office',
      'admin',
    ]);
  });

  it('maps legacy roles arrays to the single role column (spec: legacy roles migrated)', async () => {
    await dataSource.undoLastMigration(); // revert 002
    await dataSource.undoLastMigration(); // revert 001 -> legacy columns restored

    await dataSource.query(
      `INSERT INTO users (email, password, name, "roles") VALUES ($1, $2, $3, $4)`,
      ['admin@example.com', 'hashed', 'Admin', '{admin}'],
    );
    await dataSource.query(
      `INSERT INTO users (email, password, name, "roles") VALUES ($1, $2, $3, $4)`,
      ['super@example.com', 'hashed', 'Super', '{super-user}'],
    );
    await dataSource.query(
      `INSERT INTO users (email, password, name, "roles") VALUES ($1, $2, $3, $4)`,
      ['user@example.com', 'hashed', 'User', '{user}'],
    );
    await dataSource.query(
      `INSERT INTO users (email, password, name, "roles") VALUES ($1, $2, $3, $4)`,
      ['empty@example.com', 'hashed', 'Empty', '{}'],
    );

    await dataSource.runMigrations(); // 001 + 002 re-applied

    const rows: UserRow[] = await dataSource.query(
      `SELECT email, role FROM users ORDER BY email`,
    );
    expect(rows).toEqual([
      { email: 'admin@example.com', role: 'admin' },
      { email: 'empty@example.com', role: 'patient' },
      { email: 'super@example.com', role: 'admin' },
      { email: 'user@example.com', role: 'patient' },
    ]);
  });

  it('reverts to the legacy array model and restores lastName', async () => {
    await dataSource.undoLastMigration(); // revert 002
    await dataSource.undoLastMigration(); // revert 001

    const rows: LegacyUserRow[] = await dataSource.query(
      `SELECT email, "roles", "lastName" FROM users ORDER BY email`,
    );
    expect(rows).toEqual([
      { email: 'admin@example.com', roles: ['admin'], lastName: '' },
      { email: 'empty@example.com', roles: ['user'], lastName: '' },
      { email: 'super@example.com', roles: ['admin'], lastName: '' },
      { email: 'user@example.com', roles: ['user'], lastName: '' },
    ]);

    // Leave the database fully migrated for any later consumer.
    await dataSource.runMigrations();
  });

  it('aligns users columns with the ES schema (types, defaults, naming)', async () => {
    const columns: {
      column_name: string;
      udt_name: string;
      character_maximum_length: number | null;
      is_nullable: string;
      column_default: string | null;
    }[] = await dataSource.query(
      `SELECT column_name, udt_name, character_maximum_length, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
        ORDER BY ordinal_position`,
    );
    const byName = new Map(columns.map((column) => [column.column_name, column]));

    expect(byName.get('id')!.column_default).toContain('gen_random_uuid()');
    expect(byName.get('email')!.character_maximum_length).toBe(255);
    expect(byName.get('password')!.character_maximum_length).toBe(255);
    expect(byName.get('name')!.character_maximum_length).toBe(50);
    expect(byName.get('role')!.udt_name).toBe('user_role');
    expect(byName.get('role')!.is_nullable).toBe('NO');
    expect(byName.get('is_active')!.udt_name).toBe('bool');
    expect(byName.get('is_active')!.column_default).toBe('true');
    expect(byName.get('profileId')!.udt_name).toBe('int4');
    expect(byName.has('roles')).toBe(false);
    expect(byName.has('lastName')).toBe(false);
    expect(byName.has('isActive')).toBe(false);
  });
});
