import { config } from 'dotenv';

/**
 * Test-environment loader registered as a jest `setupFiles` entry.
 *
 * Runs in the worker process BEFORE AppModule/TypeOrmModule reads any
 * environment variable, so integration specs can never accidentally target
 * the development database. The hard DB_NAME guard turns a misconfiguration
 * into a loud failure instead of a silent data wipe.
 */

const TEST_ENVIRONMENT_FILE = '.env.test';
const EXPECTED_TEST_DATABASE_NAME = 'db_creditos_test';

export function assertTestDatabaseName(databaseName: string | undefined): void {
  if (databaseName !== EXPECTED_TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing to run tests: DB_NAME is '${databaseName ?? '(unset)'}', ` +
        `expected '${EXPECTED_TEST_DATABASE_NAME}'. Tests must never connect to another database.`,
    );
  }
}

export function loadTestEnvironment(): void {
  config({ path: TEST_ENVIRONMENT_FILE });
  assertTestDatabaseName(process.env.DB_NAME);
}

loadTestEnvironment();
