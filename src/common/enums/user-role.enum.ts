/**
 * Maps the PG enum type `user_role` (migration 1786000000001).
 * Value order matches the type declaration exactly.
 */
export enum UserRole {
  PATIENT = 'patient',
  DOCTOR = 'doctor',
  OFFICE = 'office',
  ADMIN = 'admin',
}
