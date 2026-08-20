import 'dotenv/config';
import { DataSource } from 'typeorm';
import { databaseConnectionOptions } from './connection-options';

/**
 * DataSource for the TypeORM CLI (migrations) — NOT used by the application.
 *
 * The NestJS runtime connection lives in src/app.module.ts and runs with
 * synchronize disabled; every schema change must be versioned as a migration
 * in src/database/migrations and applied explicitly with migration:run.
 */
export default new DataSource({
  type: 'postgres',
  ...databaseConnectionOptions(),
  synchronize: false,
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  // Timestamped glob: only versioned migration files (Laravel-style), never
  // non-migration files that may live in the same directory (e.g. specs).
  migrations: [__dirname + '/migrations/[0-9]*{.ts,.js}'],
});
