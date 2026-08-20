/**
 * El frontend de este proyecto es Vite, que sirve en 5173. Se deja tambien
 * 4200 (Angular) porque era el default historico y quitarlo romperia cualquier
 * entorno que dependa de el sin configurar CORS_ORIGINS.
 */
const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://localhost:4200'];

/**
 * Resolve the list of allowed CORS origins from the CORS_ORIGINS env var
 * (comma-separated). When unset or blank, defaults to the local dev origin.
 */
export function resolveCorsOrigins(envValue?: string): string[] {
  const raw = envValue?.trim();
  if (!raw) return [...DEFAULT_CORS_ORIGINS];
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
