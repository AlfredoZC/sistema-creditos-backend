import { Pool } from 'pg';
import { DataSource } from 'typeorm';

/**
 * Dedicated-database bootstrap for migration contract specs.
 *
 * Each migration spec owns its own throwaway database so it can prove the
 * fresh-database path (drop -> create -> migrate from Init) AND exercise
 * migration up/down cycles without ever touching the shared db_creditos_test
 * or the development database. Every run recreates the database from scratch.
 */

export const AUTH_MIGRATION_TEST_DATABASE = 'db_creditos_auth_migration_test';
export const CORE_MIGRATION_TEST_DATABASE = 'db_creditos_core_migration_test';
export const WHATSAPP_MIGRATION_TEST_DATABASE =
  'db_creditos_whatsapp_migration_test';

const MAINTENANCE_DATABASE = 'postgres';
// Timestamped glob: only versioned migration files (Laravel-style), never
// non-migration files that may live in the same directory (e.g. specs).
const MIGRATIONS_GLOB = __dirname + '/../database/migrations/[0-9]*{.ts,.js}';

/**
 * TypeORM derives each migration's timestamp from the LAST 13 characters of
 * its class name (MigrationExecutor.getMigrations does
 * `parseInt(className.substr(-13), 10)`), e.g. `WhatsAppBot1786000000003`.
 * The `upToVersion` filter below mirrors that rule so it can prove "migrate to
 * 002 only, seed legacy data, then apply 003" (task 1.5 phone-pass harness).
 */
const MIGRATION_TIMESTAMP_SUFFIX_LENGTH = 13;

function migrationTimestamp(migration: { name?: string }): number {
  return parseInt(
    (migration.name ?? '').slice(-MIGRATION_TIMESTAMP_SUFFIX_LENGTH),
    10,
  );
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

/**
 * Drops and recreates the given dedicated migration-test database, then
 * applies every pending migration from scratch (the fresh-database path).
 *
 * With `upToVersion` (a migration timestamp), only migrations at or below
 * that version are applied — the database is left with the older schema so a
 * spec can seed pre-migration data and apply the newer migration afterwards.
 */
export async function ensureFreshMigrationTestDatabase(
  databaseName: string,
  options?: { upToVersion?: number },
): Promise<void> {
  const maintenancePool = getMaintenancePool();
  try {
    await maintenancePool.query(
      `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
    );
    await maintenancePool.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await maintenancePool.end();
  }

  const dataSource = createMigrationTestDataSource(databaseName);
  await dataSource.initialize();
  try {
    // The Init migration defaults user ids to uuid_generate_v4(), which
    // requires uuid-ossp; a freshly created database does not have it.
    await dataSource.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    if (options?.upToVersion !== undefined) {
      // `migrations` is typed readonly but is a runtime seam:
      // MigrationExecutor.getMigrations() reads connection.migrations when
      // runMigrations() runs, so filtering here limits which pending
      // migrations get applied (fresh schema up to a chosen version).
      (dataSource as { migrations: Array<{ name?: string }> }).migrations =
        dataSource.migrations.filter(
          (migration) =>
            migrationTimestamp(migration) <= (options.upToVersion as number),
        );
    }
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}

export function createMigrationTestDataSource(
  databaseName: string,
): DataSource {
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    database: databaseName,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    synchronize: false,
    migrations: [MIGRATIONS_GLOB],
  });
}
