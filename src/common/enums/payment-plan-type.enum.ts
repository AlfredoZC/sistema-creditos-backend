/**
 * Maps the PG enum type `payment_plan_type` (migration 1786000000002).
 * Value order matches the type declaration exactly.
 */
export enum PaymentPlanType {
  UPFRONT = 'upfront',
  CREDIT = 'credit',
}
