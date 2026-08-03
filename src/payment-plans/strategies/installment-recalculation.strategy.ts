import { AmortizationMode, InstallmentStatus } from '../../common/enums';

/**
 * Strategy-pattern contract for amortization recalculation (design section 7).
 * Strategies are pure: they return recomputed line state and the caller persists it
 * inside the confirmation transaction (AD6). Cancelled rows are never deleted.
 */

export interface PendingInstallment {
  id: string;
  installmentNumber: number;
  totalAmount: string;
  paidAmount: string;
}

export interface RecalculatedInstallment {
  id: string;
  principalAmount: string;
  interestAmount: string;
  totalAmount: string;
  status: InstallmentStatus;
}

export interface InstallmentRecalculationContext {
  outstandingBalance: string;
  monthlyInterestRate: string;
  pendingInstallments: PendingInstallment[];
}

export interface InstallmentRecalculationStrategy {
  readonly mode: AmortizationMode;
  recalculate(context: InstallmentRecalculationContext): RecalculatedInstallment[];
}
