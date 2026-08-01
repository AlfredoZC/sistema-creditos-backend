import 'dotenv/config';
import { DataSource } from 'typeorm';

/**
 * DataSource for the TypeORM CLI (migrations) — NOT used by the application.
 *
 * The NestJS runtime connection lives in src/app.module.ts and runs with
 * synchronize disabled; every schema change must be versioned as a migration
 * in src/database/migrations and applied explicitly with migration:run.
 */
export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: +process.env.DB_PORT,
  database: process.env.DB_NAME,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  synchronize: false,
  entities: [__dirname + '/../**/*.entity{.ts,.js}'],
  migrations: [__dirname + '/migrations/*{.ts,.js}'],
});
