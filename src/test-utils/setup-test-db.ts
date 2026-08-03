import { Pool } from 'pg';
import { DataSource } from 'typeorm';

/**
 * Test-database bootstrap for integration specs.
 *
 * The whole cycle — optional drop, CREATE DATABASE when missing, uuid-ossp
 * extension, pending migrations — runs under a session-level advisory lock
 * held on the ALWAYS-CONNECTABLE maintenance database connection. Concurrent
 * test workers therefore serialize the full cycle instead of racing; the lock
 * never lives on a connection to the test database, which a concurrent drop
 * could terminate mid-flight. Idempotent: TypeORM only runs migrations not
 * recorded in the `migrations` table.
 */

const MAINTENANCE_DATABASE = 'postgres';
const TEST_DATABASE_NAME = 'db_creditos_test';
const MIGRATION_LOCK_ID = 90123;
// Timestamped glob: only versioned migration files (Laravel-style), never
// non-migration files that may live in the same directory (e.g. specs).
const MIGRATIONS_GLOB = __dirname + '/../database/migrations/[0-9]*{.ts,.js}';

interface PostgresError {
  code?: string;
}

function isDuplicateDatabaseError(error: unknown): boolean {
  return (error as PostgresError).code === '42P04';
}

function getMaintenancePool(): Pool {
  return new Pool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: MAINTENANCE_DATABASE,
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
  });
}

async function ensureTestDatabaseExists(): Promise<void> {
  const maintenancePool = getMaintenancePool();
  try {
    const databaseExists = await maintenancePool.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [TEST_DATABASE_NAME],
    );
    if (databaseExists.rowCount === 0) {
      try {
        await maintenancePool.query(`CREATE DATABASE ${TEST_DATABASE_NAME}`);
      } catch (error) {
        if (!isDuplicateDatabaseError(error)) {
          throw error;
        }
      }
    }
  } finally {
    await maintenancePool.end();
  }
}

async function runPendingMigrations(): Promise<void> {
  const dataSource = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: TEST_DATABASE_NAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    synchronize: false,
    migrations: [MIGRATIONS_GLOB],
  });
  await dataSource.initialize();
  try {
    // The Init migration defaults user ids to uuid_generate_v4(), which
    // requires uuid-ossp; a freshly created database does not have it.
    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}

async function withMigrationLock(action: () => Promise<void>): Promise<void> {
  const lockPool = getMaintenancePool();
  const lockClient = await lockPool.connect();
  try {
    // Session-level locks must be acquired and released on the SAME
    // connection; the dedicated client below is that connection.
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await action();
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    lockClient.release();
    await lockPool.end();
  }
}

/**
 * Destructive helper for integration specs that must prove the fresh-database
 * path: drops the test database under the migration advisory lock so the next
 * ensureTestDbReady() creates and migrates it from scratch. Must run in-band.
 */
export async function dropTestDatabaseForFreshRun(): Promise<void> {
  await withMigrationLock(async () => {
    const maintenancePool = getMaintenancePool();
    try {
      await maintenancePool.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE_NAME} WITH (FORCE)`);
    } finally {
      await maintenancePool.end();
    }
  });
}

export async function ensureTestDbReady(): Promise<void> {
  await withMigrationLock(async () => {
    await ensureTestDatabaseExists();
    await runPendingMigrations();
  });
}
