/**
 * Maps the PG enum type `installment_status` (migration 1786000000002).
 * Value order matches the type declaration exactly.
 */
export enum InstallmentStatus {
  PENDING = 'pending',
  PARTIAL = 'partial',
  PAID = 'paid',
  OVERDUE = 'overdue',
  CANCELLED = 'cancelled',
}
