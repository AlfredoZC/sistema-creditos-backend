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

const MAINTENANCE_DATABASE = 'postgres';
// Timestamped glob: only versioned migration files (Laravel-style), never
// non-migration files that may live in the same directory (e.g. specs).
const MIGRATIONS_GLOB = __dirname + '/../database/migrations/[0-9]*{.ts,.js}';

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
 */
export async function ensureFreshMigrationTestDatabase(
  databaseName: string,
): Promise<void> {
  const maintenancePool = getMaintenancePool();
  try {
    await maintenancePool.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
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
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}

export function createMigrationTestDataSource(databaseName: string): DataSource {
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
