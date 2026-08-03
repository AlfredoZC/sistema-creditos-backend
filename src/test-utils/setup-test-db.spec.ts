import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { ensureTestDbReady } from './setup-test-db';

jest.setTimeout(60000);

const MAINTENANCE_DATABASE = 'postgres';
const TEST_DATABASE_NAME = 'db_creditos_test';
const MIGRATIONS_DIRECTORY = path.resolve(process.cwd(), 'src', 'database', 'migrations');

function getMaintenancePool(): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: MAINTENANCE_DATABASE,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  });
}

async function dropTestDatabaseIfExists(): Promise<void> {
  const maintenancePool = getMaintenancePool();
  try {
    await maintenancePool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE_NAME} WITH (FORCE)`);
  } finally {
    await maintenancePool.end();
  }
}

async function testDatabaseExists(): Promise<boolean> {
  const maintenancePool = getMaintenancePool();
  try {
    const result = await maintenancePool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [TEST_DATABASE_NAME],
    );
    return result.rowCount === 1;
  } finally {
    await maintenancePool.end();
  }
}

async function getAppliedMigrationCount(): Promise<number> {
  const testPool = new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: TEST_DATABASE_NAME,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  });
  try {
    const result = await testPool.query('SELECT count(*)::int AS count FROM migrations');
    return result.rows[0].count as number;
  } finally {
    await testPool.end();
  }
}

function getMigrationFileCount(): number {
  return fs
    .readdirSync(MIGRATIONS_DIRECTORY)
    .filter((fileName) => fileName.endsWith('.ts')).length;
}

describe('ensureTestDbReady (harness contract, design section 12)', () => {
  beforeAll(async () => {
    await dropTestDatabaseIfExists();
  });

  it('creates a fresh test database and applies every pending migration', async () => {
    await ensureTestDbReady();
    expect(await testDatabaseExists()).toBe(true);
    expect(await getAppliedMigrationCount()).toBe(getMigrationFileCount());
  });

  it('is idempotent: repeated runs apply nothing and still succeed', async () => {
    await ensureTestDbReady();
    await ensureTestDbReady();
    expect(await getAppliedMigrationCount()).toBe(getMigrationFileCount());
  });

  it('serializes concurrent invocations without errors', async () => {
    await Promise.all([ensureTestDbReady(), ensureTestDbReady()]);
    expect(await getAppliedMigrationCount()).toBe(getMigrationFileCount());
  });
});
