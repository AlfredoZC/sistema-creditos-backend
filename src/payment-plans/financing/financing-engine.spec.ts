import Decimal from 'decimal.js';
import { FinancingEngine } from './financing-engine';
import { ScheduleLine } from './schedule-line';

const engine = new FinancingEngine();

function sumAmounts(lines: ScheduleLine[], amountKey: 'principalAmount' | 'interestAmount' | 'totalAmount'): string {
  return lines
    .reduce((total, line) => total.plus(line[amountKey]), new Decimal('0.00'))
    .toFixed(2);
}

describe('FinancingEngine.computeInstallment (design section 6.2 — A = P*i/(1-(1+i)^-n))', () => {
  it('computes the pinned base plan installment 1,113.27 for P=10,000.00, i=2%, n=10', () => {
    expect(engine.computeInstallment('10000.00', '2.00', 10)).toBe('1113.27');
  });

  it('computes the algorithm-exact 703.73 for the Option A balance (doc 703.74 is an accepted one-cent artifact)', () => {
    expect(engine.computeInstallment('5155.19', '2.00', 8)).toBe('703.73');
  });

  it('divides principal evenly with zero interest (i=0 -> P/n)', () => {
    expect(engine.computeInstallment('1200.00', '0.00', 12)).toBe('100.00');
  });

  it('returns the full principal for an upfront plan (n=1)', () => {
    expect(engine.computeInstallment('7000.00', '0.00', 1)).toBe('7000.00');
  });

  it('rounds HALF_UP when zero-interest division does not divide evenly', () => {
    expect(engine.computeInstallment('1000.00', '0.00', 3)).toBe('333.33');
  });
});

describe('FinancingEngine.generateFrenchAmortizationSchedule (design section 6.2)', () => {
  const startDate = (isoDate: string): Date => new Date(`${isoDate}T00:00:00.000Z`);

  it('reproduces the pinned base plan reference schedule exactly (spec: reference schedule)', () => {
    const lines = engine.generateFrenchAmortizationSchedule('10000.00', '2.00', 10, startDate('2026-01-15'));

    expect(lines).toHaveLength(10);
    expect(lines.map((line) => [line.principalAmount, line.interestAmount, line.totalAmount])).toEqual([
      ['913.27', '200.00', '1113.27'],
      ['931.54', '181.73', '1113.27'],
      ['950.17', '163.10', '1113.27'],
      ['969.17', '144.10', '1113.27'],
      ['988.55', '124.72', '1113.27'],
      ['1008.32', '104.95', '1113.27'],
      ['1028.49', '84.78', '1113.27'],
      ['1049.06', '64.21', '1113.27'],
      ['1070.04', '43.23', '1113.27'],
      ['1091.39', '21.83', '1113.22'],
    ]);
    expect(lines.every((line) => typeof line.totalAmount === 'string')).toBe(true);
  });

  it('sums the base plan exactly to 11,132.65 with 10,000.00 principal and 1,132.65 interest (spec: rounding remainder absorbed)', () => {
    const lines = engine.generateFrenchAmortizationSchedule('10000.00', '2.00', 10, startDate('2026-01-15'));

    expect(sumAmounts(lines, 'principalAmount')).toBe('10000.00');
    expect(sumAmounts(lines, 'interestAmount')).toBe('1132.65');
    expect(sumAmounts(lines, 'totalAmount')).toBe('11132.65');
  });

  it('emits a single zero-interest line for an upfront plan (spec: upfront plan schedule)', () => {
    const lines = engine.generateFrenchAmortizationSchedule('7000.00', '0.00', 1, startDate('2026-01-15'));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      installmentNumber: 1,
      principalAmount: '7000.00',
      interestAmount: '0.00',
      totalAmount: '7000.00',
    });
  });

  it('reproduces the pinned Option A recalculation schedule (703.73 x7, last line 703.76 absorbs the remainder)', () => {
    const lines = engine.generateFrenchAmortizationSchedule('5155.19', '2.00', 8, startDate('2026-01-15'));

    expect(lines).toHaveLength(8);
    expect(lines.slice(0, 7).map((line) => line.totalAmount)).toEqual([
      '703.73',
      '703.73',
      '703.73',
      '703.73',
      '703.73',
      '703.73',
      '703.73',
    ]);
    expect(lines[7]).toMatchObject({
      principalAmount: '689.96',
      interestAmount: '13.80',
      totalAmount: '703.76',
    });
    expect(sumAmounts(lines, 'principalAmount')).toBe('5155.19');
    expect(sumAmounts(lines, 'totalAmount')).toBe('5629.87');
  });

  it('produces equal zero-interest lines with no remainder for a divisible principal', () => {
    const lines = engine.generateFrenchAmortizationSchedule('1200.00', '0.00', 12, startDate('2026-01-15'));

    expect(lines).toHaveLength(12);
    expect(lines.every((line) => line.principalAmount === '100.00')).toBe(true);
    expect(lines.every((line) => line.interestAmount === '0.00')).toBe(true);
    expect(sumAmounts(lines, 'totalAmount')).toBe('1200.00');
  });

  it('clamps end-of-month due dates to the target month last day (spec: end-of-month clamping)', () => {
    const lines = engine.generateFrenchAmortizationSchedule('10000.00', '2.00', 4, startDate('2026-01-31'));

    expect(lines[0].dueDate.toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(lines[1].dueDate.toISOString()).toBe('2026-03-31T00:00:00.000Z');
    expect(lines[2].dueDate.toISOString()).toBe('2026-04-30T00:00:00.000Z');
  });

  it('clamps against leap-year February', () => {
    const lines = engine.generateFrenchAmortizationSchedule('10000.00', '2.00', 3, startDate('2024-01-31'));

    expect(lines[0].dueDate.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(lines[1].dueDate.toISOString()).toBe('2024-03-31T00:00:00.000Z');
  });

  it('rolls due dates over year boundaries', () => {
    const lines = engine.generateFrenchAmortizationSchedule('10000.00', '2.00', 3, startDate('2026-11-15'));

    expect(lines[0].dueDate.toISOString()).toBe('2026-12-15T00:00:00.000Z');
    expect(lines[1].dueDate.toISOString()).toBe('2027-01-15T00:00:00.000Z');
    expect(lines[2].dueDate.toISOString()).toBe('2027-02-15T00:00:00.000Z');
  });

  it('absorbs the rounding remainder exactly for a large principal over many lines', () => {
    const lines = engine.generateFrenchAmortizationSchedule('999999.99', '2.00', 24, startDate('2026-01-15'));

    expect(lines).toHaveLength(24);
    expect(sumAmounts(lines, 'principalAmount')).toBe('999999.99');
    expect(sumAmounts(lines, 'totalAmount')).toBe(
      new Decimal(sumAmounts(lines, 'principalAmount'))
        .plus(sumAmounts(lines, 'interestAmount'))
        .toFixed(2),
    );
  });

  it('keeps small principals fully amortized to the last line with 2-decimal amounts', () => {
    const lines = engine.generateFrenchAmortizationSchedule('1.00', '2.00', 12, startDate('2026-01-15'));

    expect(lines).toHaveLength(12);
    expect(lines[0]).toMatchObject({
      principalAmount: '0.07',
      interestAmount: '0.02',
      totalAmount: '0.09',
    });
    expect(sumAmounts(lines, 'principalAmount')).toBe('1.00');
  });
});
