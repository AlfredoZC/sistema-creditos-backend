/**
 * One amortization schedule row produced by the FinancingEngine (design section 6.2).
 * All money fields are fixed-point decimal strings; never JS floats.
 */
export interface ScheduleLine {
  installmentNumber: number;
  principalAmount: string;
  interestAmount: string;
  totalAmount: string;
  dueDate: Date;
}
