import Decimal from 'decimal.js';
import { AmortizationMode, InstallmentStatus } from '../../common/enums';
import { FinancingEngine } from '../financing/financing-engine';
import {
  InstallmentRecalculationContext,
  InstallmentRecalculationStrategy,
  PendingInstallment,
  RecalculatedInstallment,
} from './installment-recalculation.strategy';

const MONEY_DECIMALS = 2;
const HALF_UP_ROUNDING = Decimal.ROUND_HALF_UP;

/**
 * Default amortization recalculation (design section 7): keeps the remaining term,
 * recomputes a lower installment over the new outstanding balance, and rewrites every
 * pending line with the new amount. Pure — persistence is the caller's job (AD6).
 */
export class ReduceInstallmentRecalculationStrategy implements InstallmentRecalculationStrategy {
  readonly mode = AmortizationMode.REDUCE_INSTALLMENT;

  private readonly financingEngine = new FinancingEngine();

  recalculate(context: InstallmentRecalculationContext): RecalculatedInstallment[] {
    if (new Decimal(context.outstandingBalance).isZero()) {
      return context.pendingInstallments.map(cancelInPlace);
    }
    if (context.pendingInstallments.length === 0) {
      return [];
    }
    const installmentAmount = new Decimal(
      this.financingEngine.computeInstallment(
        context.outstandingBalance,
        context.monthlyInterestRate,
        context.pendingInstallments.length,
      ),
    );
    const monthlyRate = new Decimal(context.monthlyInterestRate).div(100);
    let outstandingBalance = new Decimal(context.outstandingBalance);
    return context.pendingInstallments.map((pendingInstallment, index) => {
      const isLastLine = index === context.pendingInstallments.length - 1;
      const interestAmount = outstandingBalance.mul(monthlyRate).toDecimalPlaces(MONEY_DECIMALS, HALF_UP_ROUNDING);
      const principalAmount = isLastLine
        ? outstandingBalance
        : installmentAmount.minus(interestAmount);
      outstandingBalance = outstandingBalance.minus(principalAmount);
      return {
        id: pendingInstallment.id,
        principalAmount: principalAmount.toFixed(MONEY_DECIMALS),
        interestAmount: interestAmount.toFixed(MONEY_DECIMALS),
        totalAmount: principalAmount.plus(interestAmount).toFixed(MONEY_DECIMALS),
        status: InstallmentStatus.PENDING,
      };
    });
  }
}

/**
 * Marks a surplus pending line as cancelled in place (rows are never deleted). The
 * original total is preserved so the row keeps a positive amount under the DB CHECKs.
 */
function cancelInPlace(pendingInstallment: PendingInstallment): RecalculatedInstallment {
  return {
    id: pendingInstallment.id,
    principalAmount: pendingInstallment.totalAmount,
    interestAmount: '0.00',
    totalAmount: pendingInstallment.totalAmount,
    status: InstallmentStatus.CANCELLED,
  };
}
