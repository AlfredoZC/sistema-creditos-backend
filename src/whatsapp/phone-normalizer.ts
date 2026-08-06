/**
 * Shared, pure phone normalizer (patient-management spec — "Canonical Phone
 * Format", design §6). No dependencies, deterministic, never guesses.
 *
 * Canonical form: +591XXXXXXXX (country code 591 + 8-digit national number,
 * mobile starts with 6 or 7). Landlines, foreign numbers and ambiguous
 * strings are kept as provided (separators stripped) so legacy formats stay
 * representable and nothing is invented.
 *
 * The migration 1786000000003 WhatsAppBot duplicates these exact rules
 * (self-contained copy) — keep both in sync (design D3).
 */

const BOLIVIA_COUNTRY_CODE = '591';
const MOBILE_PREFIX_PATTERN = /^[67]\d{7}$/;
const NATIONAL_591_PATTERN = /^591\d{8}$/;
const CANONICAL_PLUS_591_PATTERN = /^\+591\d{8}$/;

function stripSeparators(input: string): string {
  const hadLeadingPlus = input.startsWith('+');
  const digits = input.replace(/[^\d]/g, '');
  return hadLeadingPlus ? `+${digits}` : digits;
}

/**
 * Deterministic canonicalization: strip separators (single leading `+`
 * preserved), then apply the +591-mobile heuristic:
 * - 8 digits starting with 6 or 7 -> `+591` + digits
 * - 11 chars `591` + 8 digits -> `+` + digits
 * - 12 chars starting `+591` (8 following digits) -> unchanged
 * - anything else -> stripped form as-is (never guessed)
 */
export function normalizePhone(input: string): string {
  const stripped = stripSeparators(input);
  const digits = stripped.startsWith('+') ? stripped.slice(1) : stripped;

  if (MOBILE_PREFIX_PATTERN.test(digits)) {
    return `+${BOLIVIA_COUNTRY_CODE}${digits}`;
  }
  if (NATIONAL_591_PATTERN.test(digits)) {
    return `+${digits}`;
  }
  if (CANONICAL_PLUS_591_PATTERN.test(stripped)) {
    return stripped;
  }
  return stripped;
}

/**
 * Every phone comparison MUST normalize both sides before comparing
 * (patient-management spec — "Legacy format matches canonical at lookup").
 */
export function phoneMatchesLeftNormalized(left: string, right: string): boolean {
  return normalizePhone(left) === normalizePhone(right);
}