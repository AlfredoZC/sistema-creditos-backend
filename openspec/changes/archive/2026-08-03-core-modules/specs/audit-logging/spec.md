# Delta for audit-logging

## ADDED Requirements

### Requirement: In-Transaction Audit Entries

The system MUST provide an explicit `AuditService.log()` invoked INSIDE the business transaction that produced the change (no TypeORM subscribers). An audit entry MUST be written for: payment plan creation, payment confirmation, payment rejection, amortization recalculation, and surgery status changes. If the business transaction rolls back, the audit entry MUST roll back with it.

#### Scenario: Plan creation audited

- GIVEN an office user creating a payment plan
- WHEN the creation transaction commits
- THEN exactly one audit entry exists with action 'payment_plan.created', table_name 'payment_plans', the new plan's record_id, and new_data containing the plan and its schedule

#### Scenario: Recalculation audited

- GIVEN a confirmed principal_amortization
- WHEN the recalculation commits
- THEN an audit entry exists with previous_data holding the pre-recalculation installments/balance and new_data the post-recalculation state

#### Scenario: Rollback leaves no audit

- GIVEN a payment confirmation that fails mid-transaction
- WHEN the rollback completes
- THEN no audit entry for that operation exists

### Requirement: Audit Entry Shape

Entries MUST be stored in `audit_logs` with `id` uuid PK, `user_id` FK→users NULL (NULL = system action, e.g. cron), `action` text NOT NULL, `table_name` text NOT NULL, `record_id` uuid NULL (polymorphic, NO FK), `previous_data` jsonb NULL, `new_data` jsonb NULL, `created_at` timestamptz DEFAULT now(). Audit rows are append-only: they MUST NOT be updated or deleted by application code.

#### Scenario: System action attribution

- GIVEN a status change performed by a scheduled job
- WHEN the audit entry is written
- THEN user_id is NULL

#### Scenario: Actor attribution

- GIVEN an office user rejecting a payment
- WHEN the rejection commits
- THEN the audit entry's user_id equals that office user's id and previous_data/new_data hold the payment status before and after
