import Decimal from 'decimal.js';
import { AmortizationMode, InstallmentStatus } from '../../common/enums';
import { ReduceTermRecalculationStrategy } from './reduce-term.recalculation-strategy';
import {
  InstallmentRecalculationContext,
  PendingInstallment,
  RecalculatedInstallment,
} from './installment-recalculation.strategy';

const strategy = new ReduceTermRecalculationStrategy();

function buildPendingInstallments(
  count: number,
  options: { firstNumber?: number; totalAmount?: string } = {},
): PendingInstallment[] {
  const firstNumber = options.firstNumber ?? 1;
  const totalAmount = options.totalAmount ?? '1113.27';
  return Array.from({ length: count }, (_, index) => ({
    id: `installment-${firstNumber + index}`,
    installmentNumber: firstNumber + index,
    totalAmount,
    paidAmount: '0.00',
  }));
}

function sumAmounts(lines: RecalculatedInstallment[], amountKey: 'principalAmount' | 'interestAmount' | 'totalAmount'): string {
  return lines
    .reduce((total, line) => total.plus(line[amountKey]), new Decimal('0.00'))
    .toFixed(2);
}

describe('ReduceTermRecalculationStrategy (design section 7 — keep installment, shrink term)', () => {
  it('exposes the reduce-term amortization mode', () => {
    expect(strategy.mode).toBe(AmortizationMode.REDUCE_TERM);
  });

  it('keeps the installment amount and settles the remainder with a final fractional line (pinned Option B)', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '5155.19',
      monthlyInterestRate: '2.00',
      pendingInstallments: buildPendingInstallments(8, { firstNumber: 3 }),
    };

    const recalculated = strategy.recalculate(context);

    expect(recalculated).toHaveLength(8);
    expect(recalculated.map((line) => line.id)).toEqual([
      'installment-3',
      'installment-4',
      'installment-5',
      'installment-6',
      'installment-7',
      'installment-8',
      'installment-9',
      'installment-10',
    ]);
    expect(recalculated.map((line) => line.status)).toEqual([
      InstallmentStatus.PENDING,
      InstallmentStatus.PENDING,
      InstallmentStatus.PENDING,
      InstallmentStatus.PENDING,
      InstallmentStatus.PENDING,
      InstallmentStatus.CANCELLED,
      InstallmentStatus.CANCELLED,
      InstallmentStatus.CANCELLED,
    ]);
    expect(recalculated.slice(0, 4).map((line) => line.totalAmount)).toEqual([
      '1113.27',
      '1113.27',
      '1113.27',
      '1113.27',
    ]);
    expect(recalculated[4]).toMatchObject({
      principalAmount: '991.67',
      interestAmount: '19.83',
      totalAmount: '1011.50',
      status: InstallmentStatus.PENDING,
    });
  });

  it('sums the pending-line principal exactly to the outstanding balance (5,155.19) and totals to 5,464.58', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '5155.19',
      monthlyInterestRate: '2.00',
      pendingInstallments: buildPendingInstallments(8, { firstNumber: 3 }),
    };

    const pendingLines = strategy.recalculate(context).filter((line) => line.status === InstallmentStatus.PENDING);

    expect(sumAmounts(pendingLines, 'principalAmount')).toBe('5155.19');
    expect(sumAmounts(pendingLines, 'totalAmount')).toBe('5464.58');
  });

  it('preserves the original total on surplus lines cancelled in place (never deleted)', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '5155.19',
      monthlyInterestRate: '2.00',
      pendingInstallments: buildPendingInstallments(8, { firstNumber: 3 }),
    };

    const cancelledLines = strategy.recalculate(context).filter((line) => line.status === InstallmentStatus.CANCELLED);

    expect(cancelledLines).toHaveLength(3);
    expect(cancelledLines.every((line) => line.totalAmount === '1113.27')).toBe(true);
    expect(cancelledLines.every((line) => line.interestAmount === '0.00')).toBe(true);
  });

  it('cancels every pending installment when the outstanding balance is 0.00 (no recompute)', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '0.00',
      monthlyInterestRate: '2.00',
      pendingInstallments: buildPendingInstallments(8, { firstNumber: 3 }),
    };

    const recalculated = strategy.recalculate(context);

    expect(recalculated).toHaveLength(8);
    expect(recalculated.every((line) => line.status === InstallmentStatus.CANCELLED)).toBe(true);
    expect(recalculated.every((line) => line.totalAmount === '1113.27')).toBe(true);
  });

  it('returns an empty result when there are no pending installments', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '5155.19',
      monthlyInterestRate: '2.00',
      pendingInstallments: [],
    };

    expect(strategy.recalculate(context)).toEqual([]);
  });

  it('emits a single fractional installment when the remaining balance fits in one line', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '100.00',
      monthlyInterestRate: '2.00',
      pendingInstallments: buildPendingInstallments(3, { firstNumber: 3 }),
    };

    const recalculated = strategy.recalculate(context);

    expect(recalculated.map((line) => line.status)).toEqual([
      InstallmentStatus.PENDING,
      InstallmentStatus.CANCELLED,
      InstallmentStatus.CANCELLED,
    ]);
    expect(recalculated[0]).toMatchObject({
      principalAmount: '100.00',
      interestAmount: '2.00',
      totalAmount: '102.00',
    });
  });

  it('amortizes a non-divisible zero-interest balance across full lines and a fractional tail', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '1000.00',
      monthlyInterestRate: '0.00',
      pendingInstallments: buildPendingInstallments(4, { firstNumber: 3, totalAmount: '333.33' }),
    };

    const recalculated = strategy.recalculate(context);

    expect(recalculated.map((line) => [line.principalAmount, line.interestAmount, line.totalAmount])).toEqual([
      ['333.33', '0.00', '333.33'],
      ['333.33', '0.00', '333.33'],
      ['333.33', '0.00', '333.33'],
      ['0.01', '0.00', '0.01'],
    ]);
    expect(recalculated.every((line) => line.status === InstallmentStatus.PENDING)).toBe(true);
  });

  it('throws when the pending installments are exhausted before the balance is settled', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '10000.00',
      monthlyInterestRate: '2.00',
      pendingInstallments: buildPendingInstallments(1),
    };

    expect(() => strategy.recalculate(context)).toThrow(/outstanding balance/);
  });
});
