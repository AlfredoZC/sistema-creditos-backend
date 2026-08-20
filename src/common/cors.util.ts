const DEFAULT_CORS_ORIGINS = 'http://localhost:4200';

/**
 * Resolve the list of allowed CORS origins from the CORS_ORIGINS env var
 * (comma-separated). When unset or blank, defaults to the local dev origin.
 */
export function resolveCorsOrigins(envValue?: string): string[] {
  const raw = envValue?.trim();
  if (!raw) return [DEFAULT_CORS_ORIGINS];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
