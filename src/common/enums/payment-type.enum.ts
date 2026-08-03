/**
 * Maps the PG enum type `payment_type` (migration 1786000000002).
 * Value order matches the type declaration exactly.
 */
export enum PaymentType {
  DOWN_PAYMENT = 'down_payment',
  INSTALLMENT_PAYMENT = 'installment_payment',
  PRINCIPAL_AMORTIZATION = 'principal_amortization',
}
