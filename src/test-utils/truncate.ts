import { DataSource } from 'typeorm';

/**
 * Wipes every business table for a clean slate between integration tests.
 *
 * Table names come from information_schema (system-owned), are double-quoted,
 * and run through a single TRUNCATE ... RESTART IDENTITY CASCADE statement.
 * The TypeORM `migrations` bookkeeping table is deliberately excluded:
 * truncating it would make the next ensureTestDbReady re-run every migration
 * against a schema that already exists.
 */

const MIGRATIONS_TABLE = 'migrations';

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
  const quotedTableNames = rows.map((row) => `"${row.tableName}"`).join(', ');
  await dataSource.query(`TRUNCATE TABLE ${quotedTableNames} RESTART IDENTITY CASCADE`);
}
