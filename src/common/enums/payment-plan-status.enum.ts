/**
 * Maps the PG enum type `payment_plan_status` (migration 1786000000002).
 * Value order matches the type declaration exactly.
 */
export enum PaymentPlanStatus {
  ACTIVE = 'active',
  COMPLETED = 'completed',
  DELINQUENT = 'delinquent',
  CANCELLED = 'cancelled',
}
