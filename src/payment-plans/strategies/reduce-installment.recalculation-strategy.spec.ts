import Decimal from 'decimal.js';
import { AmortizationMode, InstallmentStatus } from '../../common/enums';
import { ReduceInstallmentRecalculationStrategy } from './reduce-installment.recalculation-strategy';
import {
  InstallmentRecalculationContext,
  PendingInstallment,
  RecalculatedInstallment,
} from './installment-recalculation.strategy';

const strategy = new ReduceInstallmentRecalculationStrategy();

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

function sumAmounts(
  lines: RecalculatedInstallment[],
  amountKey: 'principalAmount' | 'interestAmount' | 'totalAmount',
): string {
  return lines
    .reduce((total, line) => total.plus(line[amountKey]), new Decimal('0.00'))
    .toFixed(2);
}

describe('ReduceInstallmentRecalculationStrategy (design section 7 — keep term, lower installment)', () => {
  it('exposes the reduce-installment amortization mode', () => {
    expect(strategy.mode).toBe(AmortizationMode.REDUCE_INSTALLMENT);
  });

  it('recomputes every pending installment with the pinned Option A amounts (703.73 x7, last line 703.76)', () => {
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
    expect(recalculated.map((line) => line.totalAmount)).toEqual([
      '703.73',
      '703.73',
      '703.73',
      '703.73',
      '703.73',
      '703.73',
      '703.73',
      '703.76',
    ]);
    expect(recalculated[7]).toMatchObject({
      principalAmount: '689.96',
      interestAmount: '13.80',
      totalAmount: '703.76',
    });
    expect(
      recalculated.every((line) => line.status === InstallmentStatus.PENDING),
    ).toBe(true);
  });

  it('sums the recomputed principal exactly to the outstanding balance (5,155.19) and totals to 5,629.87', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '5155.19',
      monthlyInterestRate: '2.00',
      pendingInstallments: buildPendingInstallments(8, { firstNumber: 3 }),
    };

    const recalculated = strategy.recalculate(context);

    expect(sumAmounts(recalculated, 'principalAmount')).toBe('5155.19');
    expect(sumAmounts(recalculated, 'totalAmount')).toBe('5629.87');
  });

  it('cancels every pending installment when the outstanding balance is 0.00 (no recompute)', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '0.00',
      monthlyInterestRate: '2.00',
      pendingInstallments: buildPendingInstallments(8, { firstNumber: 3 }),
    };

    const recalculated = strategy.recalculate(context);

    expect(recalculated).toHaveLength(8);
    expect(
      recalculated.every((line) => line.status === InstallmentStatus.CANCELLED),
    ).toBe(true);
    expect(recalculated.every((line) => line.totalAmount === '1113.27')).toBe(
      true,
    );
  });

  it('returns an empty result when there are no pending installments', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '5155.19',
      monthlyInterestRate: '2.00',
      pendingInstallments: [],
    };

    expect(strategy.recalculate(context)).toEqual([]);
  });

  it('settles a single pending installment with interest on the outstanding balance', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '500.00',
      monthlyInterestRate: '2.00',
      pendingInstallments: buildPendingInstallments(1),
    };

    const recalculated = strategy.recalculate(context);

    expect(recalculated).toHaveLength(1);
    expect(recalculated[0]).toMatchObject({
      principalAmount: '500.00',
      interestAmount: '10.00',
      totalAmount: '510.00',
      status: InstallmentStatus.PENDING,
    });
  });

  it('amortizes a non-divisible zero-interest balance exactly across the last line', () => {
    const context: InstallmentRecalculationContext = {
      outstandingBalance: '1000.00',
      monthlyInterestRate: '0.00',
      pendingInstallments: buildPendingInstallments(3),
    };

    const recalculated = strategy.recalculate(context);

    expect(
      recalculated.map((line) => [
        line.principalAmount,
        line.interestAmount,
        line.totalAmount,
      ]),
    ).toEqual([
      ['333.33', '0.00', '333.33'],
      ['333.33', '0.00', '333.33'],
      ['333.34', '0.00', '333.34'],
    ]);
    expect(sumAmounts(recalculated, 'principalAmount')).toBe('1000.00');
  });
});
