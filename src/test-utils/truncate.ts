import { DataSource } from 'typeorm';

/**
 * Wipes every business table for a clean slate between integration tests.
 *
 * Table names come from information_schema (system-owned), are double-quoted,
 * and run through a single TRUNCATE ... RESTART IDENTITY CASCADE statement.
 * The TypeORM `migrations` bookkeeping table is deliberately excluded:
 * truncating it would make the next ensureTestDbReady re-run every migration
 * against a schema that already exists.
 *
 * `payment_methods` is excluded for the same reason: it is reference data
 * seeded once by migration 002 (cash, bank_transfer, qr, card). Migrations
 * never re-run, the seed service deliberately does not touch it, and wiping
 * it would permanently destroy the payment-methods catalog every time this
 * helper runs (the design's own seed wipe list excludes it too).
 */

const MIGRATIONS_TABLE = 'migrations';
const REFERENCE_DATA_TABLES = new Set(['payment_methods']);

export async function truncateAllTables(dataSource: DataSource): Promise<void> {
  const rows: { tableName: string }[] = await dataSource.query(
    `SELECT table_name AS "tableName"
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name <> $1
      ORDER BY table_name`,
    [MIGRATIONS_TABLE],
  );
  if (rows.length === 0) {
    return;
  }
  const quotedTableNames = rows
    .map((row) => row.tableName)
    .filter((tableName) => !REFERENCE_DATA_TABLES.has(tableName))
    .map((tableName) => `"${tableName}"`)
    .join(', ');
  if (quotedTableNames.length === 0) {
    return;
  }
  await dataSource.query(`TRUNCATE TABLE ${quotedTableNames} RESTART IDENTITY CASCADE`);
}
