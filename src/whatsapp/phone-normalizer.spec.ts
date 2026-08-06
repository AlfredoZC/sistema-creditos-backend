import { normalizePhone, phoneMatchesLeftNormalized } from './phone-normalizer';

describe('phone normalizer (patient-management spec — Canonical Phone Format)', () => {
  describe('Mobile input canonicalized', () => {
    it('canonicalizes an 8-digit mobile starting with 6 or 7', () => {
      expect(normalizePhone('70000001')).toBe('+59170000001');
    });

    it('canonicalizes a 591-prefixed national number', () => {
      expect(normalizePhone('59170000001')).toBe('+59170000001');
    });

    it('strips separators before applying the mobile heuristic', () => {
      expect(normalizePhone('+591 7000-0001')).toBe('+59170000001');
      expect(normalizePhone('7000-0001')).toBe('+59170000001');
    });

    it('leaves an already canonical +591 mobile unchanged', () => {
      expect(normalizePhone('+59170000001')).toBe('+59170000001');
    });
  });

  describe('Landline or foreign stored as-is', () => {
    it('keeps a landline exactly as provided (heuristic never guesses)', () => {
      expect(normalizePhone('24000000')).toBe('24000000');
    });

    it('keeps a foreign number exactly as provided, separators stripped', () => {
      expect(normalizePhone('+541123456789')).toBe('+541123456789');
    });
  });

  describe('Legacy format matches canonical at lookup', () => {
    it('matches a legacy separated format against a canonical wa_id', () => {
      expect(phoneMatchesLeftNormalized('+591 7000-0001', '59170000001')).toBe(
        true,
      );
    });

    it('does not match different numbers', () => {
      expect(phoneMatchesLeftNormalized('+59170000001', '24000000')).toBe(
        false,
      );
    });

    it('normalizes both sides equally (idempotent comparison)', () => {
      expect(
        phoneMatchesLeftNormalized('+59170000001', '+591 7000-0001'),
      ).toBe(true);
    });
  });
});