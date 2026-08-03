/**
 * Maps the PG enum type `amortization_mode` (migration 1786000000002).
 * Value order matches the type declaration exactly.
 */
export enum AmortizationMode {
  REDUCE_INSTALLMENT = 'reduce_installment',
  REDUCE_TERM = 'reduce_term',
}
