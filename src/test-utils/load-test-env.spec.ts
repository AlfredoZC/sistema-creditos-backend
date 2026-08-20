import { assertTestDatabaseName, loadTestEnvironment } from './load-test-env';

describe('load-test-env (harness contract, design section 12)', () => {
  it('worker process loads .env.test via jest setupFiles before any test runs', () => {
    expect(process.env.DB_NAME).toBe('db_creditos_test');
    expect(process.env.DB_PORT).toBe('5439');
    expect(process.env.DB_HOST).toBe('localhost');
    expect(process.env.DB_USERNAME).toBe('root');
  });

  it('loadTestEnvironment reloads the test environment without clobbering values', () => {
    loadTestEnvironment();
    expect(process.env.DB_NAME).toBe('db_creditos_test');
    expect(process.env.JWT_SECRET).toBe('test-secret');
  });

  it('fails loudly when DB_NAME is not the test database', () => {
    expect(() => assertTestDatabaseName('db_creditos')).toThrow(
      /db_creditos_test/,
    );
    expect(() => assertTestDatabaseName(undefined)).toThrow(/db_creditos_test/);
    expect(() => assertTestDatabaseName('')).toThrow(/db_creditos_test/);
  });

  it('accepts the test database name without throwing', () => {
    expect(() => assertTestDatabaseName('db_creditos_test')).not.toThrow();
  });
});
