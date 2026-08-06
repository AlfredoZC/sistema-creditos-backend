import { parseIntent } from './intent-parser';

describe('intent parser (design section 9.4 — pure, no DI)', () => {
  it('maps "saldo" to the saldo intent', () => {
    expect(parseIntent('saldo')).toBe('saldo');
  });

  it('maps cuota and cuotas to the cuotas intent', () => {
    expect(parseIntent('cuota')).toBe('cuotas');
    expect(parseIntent('cuotas')).toBe('cuotas');
  });

  it('maps proxima, proximo, and next to the proxima intent', () => {
    expect(parseIntent('proxima')).toBe('proxima');
    expect(parseIntent('proximo')).toBe('proxima');
    expect(parseIntent('next')).toBe('proxima');
  });

  it('matches case-insensitively', () => {
    expect(parseIntent('SALDO')).toBe('saldo');
    expect(parseIntent('Cuotas')).toBe('cuotas');
  });

  it('strips diacritics so accented keywords match', () => {
    expect(parseIntent('próxima')).toBe('proxima');
    expect(parseIntent('PRÓXIMO')).toBe('proxima');
    expect(parseIntent('cuóta')).toBe('cuotas');
  });

  it('ignores surrounding whitespace', () => {
    expect(parseIntent('  saldo  ')).toBe('saldo');
  });

  it('returns null for unknown input', () => {
    expect(parseIntent('hola')).toBeNull();
    expect(parseIntent('cuál es mi deuda')).toBeNull();
    expect(parseIntent('12345')).toBeNull();
  });

  it('returns null for empty or whitespace-only input', () => {
    expect(parseIntent('')).toBeNull();
    expect(parseIntent('   ')).toBeNull();
  });
});
