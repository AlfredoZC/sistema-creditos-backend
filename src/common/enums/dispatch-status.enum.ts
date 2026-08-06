/**
 * Maps the PG enum type `dispatch_status` (migration 1786000000003 WhatsAppBot).
 * Value order matches the type declaration exactly.
 */
export enum DispatchStatus {
  QUEUED = 'queued',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}
