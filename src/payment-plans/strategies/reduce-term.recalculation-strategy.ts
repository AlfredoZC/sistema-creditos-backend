import Decimal from 'decimal.js';
import { AmortizationMode, InstallmentStatus } from '../../common/enums';
import {
  InstallmentRecalculationContext,
  InstallmentRecalculationStrategy,
  PendingInstallment,
  RecalculatedInstallment,
} from './installment-recalculation.strategy';

const MONEY_DECIMALS = 2;
const HALF_UP_ROUNDING = Decimal.ROUND_HALF_UP;

/**
 * Amortization recalculation that keeps the current installment amount (design section
 * 7): the remaining principal is settled in fewer full installments plus one final
 * fractional line, and surplus trailing pending lines are cancelled in place — rows
 * are never deleted. Pure — persistence is the caller's job (AD6).
 */
export class ReduceTermRecalculationStrategy implements InstallmentRecalculationStrategy {
  readonly mode = AmortizationMode.REDUCE_TERM;

  recalculate(context: InstallmentRecalculationContext): RecalculatedInstallment[] {
    if (new Decimal(context.outstandingBalance).isZero()) {
      return context.pendingInstallments.map(cancelInPlace);
    }
    if (context.pendingInstallments.length === 0) {
      return [];
    }
    const installmentAmount = new Decimal(context.pendingInstallments[0].totalAmount);
    const monthlyRate = new Decimal(context.monthlyInterestRate).div(100);
    let outstandingBalance = new Decimal(context.outstandingBalance);
    const recalculated: RecalculatedInstallment[] = [];
    for (let index = 0; index < context.pendingInstallments.length; index++) {
      if (outstandingBalance.mul(new Decimal(1).plus(monthlyRate)).lte(installmentAmount)) {
        const interestAmount = outstandingBalance.mul(monthlyRate).toDecimalPlaces(MONEY_DECIMALS, HALF_UP_ROUNDING);
        recalculated.push({
          id: context.pendingInstallments[index].id,
          principalAmount: outstandingBalance.toFixed(MONEY_DECIMALS),
          interestAmount: interestAmount.toFixed(MONEY_DECIMALS),
          totalAmount: outstandingBalance.plus(interestAmount).toFixed(MONEY_DECIMALS),
          status: InstallmentStatus.PENDING,
        });
        for (let surplusIndex = index + 1; surplusIndex < context.pendingInstallments.length; surplusIndex++) {
          recalculated.push(cancelInPlace(context.pendingInstallments[surplusIndex]));
        }
        outstandingBalance = new Decimal('0.00');
        break;
      }
      const interestAmount = outstandingBalance.mul(monthlyRate).toDecimalPlaces(MONEY_DECIMALS, HALF_UP_ROUNDING);
      const principalAmount = installmentAmount.minus(interestAmount);
      recalculated.push({
        id: context.pendingInstallments[index].id,
        principalAmount: principalAmount.toFixed(MONEY_DECIMALS),
        interestAmount: interestAmount.toFixed(MONEY_DECIMALS),
        totalAmount: installmentAmount.toFixed(MONEY_DECIMALS),
        status: InstallmentStatus.PENDING,
      });
      outstandingBalance = outstandingBalance.minus(principalAmount);
    }
    if (!outstandingBalance.isZero()) {
      throw new Error(
        'ReduceTermRecalculationStrategy: pending installments were exhausted before the outstanding balance was settled',
      );
    }
    return recalculated;
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
