/**
 * Maps the PG enum type `surgery_status` (migration 1786000000002).
 * Value order matches the type declaration exactly.
 */
export enum SurgeryStatus {
  SCHEDULED = 'scheduled',
  PERFORMED = 'performed',
  CANCELLED = 'cancelled',
}
