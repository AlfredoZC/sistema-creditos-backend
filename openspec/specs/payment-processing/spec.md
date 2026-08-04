# Payment Processing Specification

## Requirements

### Requirement: Payment Methods Catalog

The system MUST store methods in `payment_methods` (`name` varchar(50) UNIQUE, `is_enabled` boolean DEFAULT true) and seed `cash`, `bank_transfer`, `qr`, `card`. Payments referencing a disabled method MUST be rejected.

#### Scenario: Disabled method rejected

- GIVEN method `card` with is_enabled=false
- WHEN a payment is registered with that method
- THEN the request MUST fail with 409 Conflict

### Requirement: Payment Registration and Auto-Confirmation

Payments live in `payments` with `amount` CHECK `> 0`, `paid_at` DEFAULT now(), `recorded_by_user_id` NOT NULL (the registering user: office at the counter, or the patient's own user on receipt upload), `patient_user_id` NULL allowed, `receipt_url` NULL. Payments registered by office/admin MUST auto-confirm at registration (effects applied in the same transaction). Payments registered by a patient (receipt upload) MUST stay 'pending_confirmation' until office confirmation.

#### Scenario: Office counter payment auto-confirms

- GIVEN an office user registering an installment_payment of 1,113.27
- WHEN the registration commits
- THEN the payment status is 'confirmed' and the installment/balance effects are already applied

#### Scenario: Patient receipt upload stays pending

- GIVEN a patient-role user uploading a receipt for an installment
- WHEN the payment is registered
- THEN its status is 'pending_confirmation' and no balance, installment, or schedule effect occurs

### Requirement: Payment Type Integrity Rules

The SQL CHECK constraints MUST be enforced in the service layer AND in the DB: `principal_amortization` ⇒ `installment_id` IS NULL; `installment_payment` ⇒ `installment_id` IS NOT NULL; `amortization_mode` IS NOT NULL ⇔ `type='principal_amortization'` (enum: 'reduce_installment','reduce_term').

#### Scenario: Type/constraint violations rejected

- GIVEN a payload violating any integrity rule (amortization with installment_id, installment_payment without installment_id, or amortization_mode on a non-amortization type)
- WHEN it is registered
- THEN the service MUST reject it with 400 Bad Request and persist nothing

### Requirement: Confirmation State Machine

`payment_status` MUST follow `pending_confirmation → confirmed | rejected`; both targets are terminal. Only office/admin MAY confirm or reject. Rejection MUST change nothing else: no balance, installment, or schedule effects, no recalculation. Confirming a `principal_amortization` triggers recalculation (see payment-plans).

#### Scenario: Rejection is side-effect free

- GIVEN a pending payment of 3,000.00 against a plan with outstanding_balance 8,155.19
- WHEN an office user rejects it
- THEN status is 'rejected', outstanding_balance remains 8,155.19, and all installments are unchanged

#### Scenario: Patient cannot confirm

- GIVEN a pending payment
- WHEN a patient-role user attempts to confirm or reject it
- THEN the request MUST fail with 403 Forbidden

#### Scenario: Terminal states

- GIVEN a payment already 'confirmed' or 'rejected'
- WHEN a further confirm/reject is attempted
- THEN the request MUST fail with 409 Conflict

### Requirement: Installment Payment Application and Overdue

A confirmed `installment_payment` MUST add its amount to the installment's `paid_amount` accumulator: 'pending' → 'partial' (0 < paid_amount < total_amount) → 'paid' (paid_amount >= total_amount). An installment is overdue when `due_date < today AND status IN ('pending','partial')`: overdue MUST be derived at read time; a cron SHOULD also persist status 'overdue' for the reminder/bot phase.

#### Scenario: Partial payment

- GIVEN installment #3 with total_amount 1,113.27 and paid_amount 0
- WHEN an installment_payment of 500.00 is confirmed
- THEN paid_amount is 500.00 and status is 'partial'

#### Scenario: Installment fully paid

- GIVEN the same installment with paid_amount 500.00
- WHEN an installment_payment of 613.27 is confirmed
- THEN paid_amount is 1,113.27 and status is 'paid'

#### Scenario: Overdue derived at read

- GIVEN installment #4 with due_date yesterday and status 'pending'
- WHEN the plan schedule is read today
- THEN installment #4 is reported as overdue without any write having occurred

### Requirement: Transaction Boundaries for Money-Touching Endpoints

These endpoints MUST execute in a single DB transaction: plan creation (plan + schedule + down payment + audit); payment registration (row + auto-confirmation effects + audit); payment confirmation (SELECT FOR UPDATE on the plan row + status + balance/installment effects + recalculation + audit); payment rejection (status + audit).

#### Scenario: Confirmation failure rolls back everything

- GIVEN a pending principal_amortization
- WHEN any step of confirmation fails (e.g. recalculation error)
- THEN payment status, plan balance, installments, and audit log MUST all remain unchanged
