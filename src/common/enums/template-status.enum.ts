/**
 * Maps the PG enum type `template_status` (migration 1786000000003 WhatsAppBot).
 * Value order matches the type declaration exactly.
 */
export enum TemplateStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  PAUSED = 'paused',
}
