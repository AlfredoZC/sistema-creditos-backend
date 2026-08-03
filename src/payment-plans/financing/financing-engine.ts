import Decimal from 'decimal.js';
import { ScheduleLine } from './schedule-line';

const MONEY_DECIMALS = 2;
const HALF_UP_ROUNDING = Decimal.ROUND_HALF_UP;

/**
 * Pure French amortization calculator (design section 6.2). No database dependency.
 *
 * Money contract: decimal-string arithmetic via decimal.js, HALF_UP to 2 decimals per
 * line, and the LAST line's principal is the remaining balance unconditionally so the
 * rounding remainder is absorbed by construction (sum of principal equals P exactly).
 */
export class FinancingEngine {
  /**
   * Fixed-installment amount A = P*i/(1-(1+i)^-n), HALF_UP to 2 decimals.
   * For i=0 the installment is P/n. `monthlyInterestRate` is a percentage ('2.00' = 2%).
   */
  computeInstallment(principal: string, monthlyInterestRate: string, installmentCount: number): string {
    const principalAmount = new Decimal(principal);
    const monthlyRate = this.toMonthlyRate(monthlyInterestRate);
    if (monthlyRate.isZero()) {
      return principalAmount
        .div(installmentCount)
        .toDecimalPlaces(MONEY_DECIMALS, HALF_UP_ROUNDING)
        .toFixed(MONEY_DECIMALS);
    }
    const discountFactor = new Decimal(1).div(new Decimal(1).add(monthlyRate).pow(installmentCount));
    const installment = principalAmount.mul(monthlyRate).div(new Decimal(1).sub(discountFactor));
    return installment.toDecimalPlaces(MONEY_DECIMALS, HALF_UP_ROUNDING).toFixed(MONEY_DECIMALS);
  }

  /**
   * Generates the full schedule over `principal` (French amortization, due dates at
   * `startDate + k` calendar months with day overflow clamped to the target month's
   * last day). The last line absorbs the principal rounding remainder by construction.
   */
  generateFrenchAmortizationSchedule(
    principal: string,
    monthlyInterestRate: string,
    installmentCount: number,
    startDate: Date,
  ): ScheduleLine[] {
    const installmentAmount = new Decimal(this.computeInstallment(principal, monthlyInterestRate, installmentCount));
    const monthlyRate = this.toMonthlyRate(monthlyInterestRate);
    let outstandingBalance = new Decimal(principal);
    const lines: ScheduleLine[] = [];
    for (let installmentNumber = 1; installmentNumber <= installmentCount; installmentNumber++) {
      const interestAmount = outstandingBalance.mul(monthlyRate).toDecimalPlaces(MONEY_DECIMALS, HALF_UP_ROUNDING);
      const isLastLine = installmentNumber === installmentCount;
      const principalAmount = isLastLine ? outstandingBalance : installmentAmount.minus(interestAmount);
      lines.push({
        installmentNumber,
        principalAmount: principalAmount.toFixed(MONEY_DECIMALS),
        interestAmount: interestAmount.toFixed(MONEY_DECIMALS),
        totalAmount: principalAmount.plus(interestAmount).toFixed(MONEY_DECIMALS),
        dueDate: addMonthsClamped(startDate, installmentNumber),
      });
      outstandingBalance = outstandingBalance.minus(principalAmount);
    }
    return lines;
  }

  private toMonthlyRate(monthlyInterestRate: string): Decimal {
    return new Decimal(monthlyInterestRate).div(100);
  }
}

/**
 * Returns `startDate` plus `months` calendar months on (y, m, d) parts via Date.UTC
 * (no timezone or DST drift), clamping the day to the target month's last day when
 * the start day overflows (e.g. 2026-01-31 + 1 month -> 2026-02-28).
 */
function addMonthsClamped(startDate: Date, months: number): Date {
  const startYear = startDate.getUTCFullYear();
  const startMonth = startDate.getUTCMonth();
  const startDay = startDate.getUTCDate();
  const targetMonthIndex = startMonth + months;
  const targetYear = startYear + Math.floor(targetMonthIndex / 12);
  const targetMonth = targetMonthIndex % 12;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(startDay, lastDayOfTargetMonth)));
}
