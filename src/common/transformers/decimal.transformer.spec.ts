import { decimalTransformer } from './decimal.transformer';

describe('DecimalTransformer (design section 5.1 — money columns round-trip as strings)', () => {
  it('to stringifies a numeric string verbatim', () => {
    expect(decimalTransformer.to('913.27')).toBe('913.27');
    expect(decimalTransformer.to('0.00')).toBe('0.00');
  });

  it('to stringifies a number input without introducing float drift', () => {
    expect(decimalTransformer.to(913.27)).toBe('913.27');
  });

  it('to passes null and undefined through unchanged', () => {
    expect(decimalTransformer.to(null)).toBeNull();
    expect(decimalTransformer.to(undefined)).toBeUndefined();
  });

  it('from returns the pg numeric string verbatim, never a JS float', () => {
    const value = decimalTransformer.from('913.27');
    expect(value).toBe('913.27');
    expect(typeof value).toBe('string');
  });

  it('from passes null and undefined through unchanged', () => {
    expect(decimalTransformer.from(null)).toBeNull();
    expect(decimalTransformer.from(undefined)).toBeUndefined();
  });

  it('round-trips a stored value back to the identical string', () => {
    const stored = decimalTransformer.to('913.27');
    const readBack = decimalTransformer.from(stored as string);
    expect(readBack).toBe('913.27');
  });
});
