import { DataSource } from 'typeorm';
import { ensureTestDbReady } from './setup-test-db';
import { truncateAllTables } from './truncate';

jest.setTimeout(60000);

const TEST_DATABASE_NAME = 'db_creditos_test';

let dataSource: DataSource;

async function getTableRowCount(tableName: string): Promise<number> {
  const result: { count: number }[] = await dataSource.query(
    `SELECT count(*)::int AS count FROM "${tableName}"`,
  );
  return result[0].count;
}

async function insertUser(email: string): Promise<void> {
  await dataSource.query(
    `INSERT INTO users (email, password, name, "lastName") VALUES ($1, 'hashed', 'Name', 'Last')`,
    [email],
  );
}

async function insertProfile(): Promise<number> {
  const result: { id: number }[] = await dataSource.query(
    `INSERT INTO profiles (gender) VALUES ('test') RETURNING id`,
  );
  return result[0].id;
}

describe('truncateAllTables (harness contract, design section 12)', () => {
  beforeAll(async () => {
    await ensureTestDbReady();
    dataSource = new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      database: TEST_DATABASE_NAME,
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      synchronize: false,
    });
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('empties every business table between tests', async () => {
    await truncateAllTables(dataSource);
    await insertUser('first@example.com');
    await insertUser('second@example.com');
    await insertProfile();
    expect(await getTableRowCount('users')).toBe(2);
    expect(await getTableRowCount('profiles')).toBe(1);

    await truncateAllTables(dataSource);

    expect(await getTableRowCount('users')).toBe(0);
    expect(await getTableRowCount('profiles')).toBe(0);
  });

  it('preserves the migrations bookkeeping table', async () => {
    await truncateAllTables(dataSource);
    const appliedMigrationsBefore = await getTableRowCount('migrations');

    await truncateAllTables(dataSource);

    expect(appliedMigrationsBefore).toBeGreaterThan(0);
    expect(await getTableRowCount('migrations')).toBe(appliedMigrationsBefore);
  });

  it('restarts serial identity sequences on every table', async () => {
    await truncateAllTables(dataSource);
    const firstInsertedId = await insertProfile();
    const secondInsertedId = await insertProfile();
    expect(secondInsertedId).toBeGreaterThan(firstInsertedId);

    await truncateAllTables(dataSource);

    expect(await insertProfile()).toBe(1);
  });
});
