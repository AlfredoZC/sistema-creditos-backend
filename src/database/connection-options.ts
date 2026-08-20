import type { TlsOptions } from 'tls';

/**
 * Parametros de conexion compartidos por el runtime de NestJS y el DataSource
 * del CLI de migraciones. Vivian duplicados en los dos lados, asi que agregar
 * SSL en uno y olvidarlo en el otro dejaba las migraciones sin poder conectar.
 */
export interface DatabaseConnectionOptions {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl: boolean | TlsOptions;
}

export function databaseConnectionOptions(): DatabaseConnectionOptions {
  return {
    host: process.env.DB_HOST,
    port: +process.env.DB_PORT,
    database: process.env.DB_NAME,
    username: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    // Postgres administrado (Neon, RDS y companiia) rechaza conexiones sin TLS.
    // En local, con la base en Docker, no hay TLS y el flag queda apagado.
    ssl: process.env.DB_SSL === 'true',
  };
}
