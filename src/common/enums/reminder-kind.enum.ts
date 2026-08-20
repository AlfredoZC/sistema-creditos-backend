/**
 * Tipo de recordatorio de cuota. Mapea el enum PG `installment_reminder_kind`
 * (migracion 1786000000005).
 */
export enum ReminderKind {
  DUE_SOON = 'due_soon',
  OVERDUE = 'overdue',
}
