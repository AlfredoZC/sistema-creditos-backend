/**
 * Maps the PG enum type `payment_status` (migration 1786000000002).
 * Value order matches the type declaration exactly.
 */
export enum PaymentStatus {
  PENDING_CONFIRMATION = 'pending_confirmation',
  CONFIRMED = 'confirmed',
  REJECTED = 'rejected',
}
