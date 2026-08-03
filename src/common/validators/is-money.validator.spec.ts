import { validateSync } from 'class-validator';
import { IsMoney } from './is-money.validator';

class MoneyFieldDto {
  @IsMoney()
  amount: string;
}

function validateAmount(amount: string): string[] {
  const dto = new MoneyFieldDto();
  dto.amount = amount;
  return validateSync(dto).map((error) => error.property);
}

describe('IsMoney validator (design section 5 — non-negative decimal, at most 2 dp)', () => {
  it('accepts whole and two-decimal non-negative amounts', () => {
    expect(validateAmount('0')).toEqual([]);
    expect(validateAmount('0.00')).toEqual([]);
    expect(validateAmount('8000.00')).toEqual([]);
    expect(validateAmount('913.27')).toEqual([]);
  });

  it('rejects negative amounts', () => {
    expect(validateAmount('-1.00')).toEqual(['amount']);
    expect(validateAmount('-0.01')).toEqual(['amount']);
  });

  it('rejects more than two decimal places', () => {
    expect(validateAmount('1.234')).toEqual(['amount']);
    expect(validateAmount('0.001')).toEqual(['amount']);
  });

  it('rejects non-numeric input', () => {
    expect(validateAmount('abc')).toEqual(['amount']);
    expect(validateAmount('')).toEqual(['amount']);
    expect(validateAmount('1,000.00')).toEqual(['amount']);
    expect(validateAmount(' 1.00')).toEqual(['amount']);
  });
});
