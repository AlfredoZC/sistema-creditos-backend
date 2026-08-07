import { resolveCorsOrigins } from './cors.util';

describe('resolveCorsOrigins', () => {
  it('defaults to http://localhost:4200 when CORS_ORIGINS is unset', () => {
    expect(resolveCorsOrigins(undefined)).toEqual(['http://localhost:4200']);
  });

  it('defaults when the env value is empty or blank', () => {
    expect(resolveCorsOrigins('')).toEqual(['http://localhost:4200']);
    expect(resolveCorsOrigins('   ')).toEqual(['http://localhost:4200']);
  });

  it('returns a single prod origin unchanged', () => {
    expect(resolveCorsOrigins('https://app.example.com')).toEqual(['https://app.example.com']);
  });

  it('splits comma-separated origins and trims spaces', () => {
    expect(
      resolveCorsOrigins('https://app.example.com, http://localhost:4200'),
    ).toEqual(['https://app.example.com', 'http://localhost:4200']);
  });
});