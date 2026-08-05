/**
 * Pure intent parser (design section 9.4): normalizes the inbound text
 * (lowercase + strip diacritics via NFD combining-mark removal, so "próxima"
 * matches "proxima") and maps the menu keywords to the bot intents. Unknown
 * or empty input -> null. No Nest DI, no side effects.
 */
export type BotIntent = 'saldo' | 'cuotas' | 'proxima';

const INTENT_KEYWORDS: Record<string, BotIntent> = {
  saldo: 'saldo',
  cuota: 'cuotas',
  cuotas: 'cuotas',
  proxima: 'proxima',
  proximo: 'proxima',
  next: 'proxima',
};

export function parseIntent(text: string): BotIntent | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return INTENT_KEYWORDS[normalized] ?? null;
}
