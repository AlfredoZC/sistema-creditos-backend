# Delta for payment-plans

## ADDED Requirements

### Requirement: Patient-Scoped Debt Summary Read

The system MUST provide a debt-summary read scoped by `patient_id` (or by normalized phone), NOT by the caller's user, serving hybrid patients (`user_id` NULL). It MUST return `outstanding_balance`, the next due installment (`installment_number`, `total_amount`, `due_date`), and the overdue total as fixed-point decimal strings; overdue MUST be derived at read time (`due_date < today` and status pending|partial). A patient with no plan MUST receive a zero summary. The read MUST be consumed server-side by the WhatsApp bot for identified conversations and MUST require the bot service context or office/admin authentication; it MUST NOT be exposed as a patient-role web route. Existing user-gated reads MUST remain unchanged and stay the only user-scoped path.

#### Scenario: Hybrid patient summary

- GIVEN a hybrid patient (user_id NULL) with a credit plan, one overdue and one pending installment
- WHEN the bot requests the summary by patient_id
- THEN it receives outstanding_balance "8155.19", next due installment 2 amount "1113.27" due "2026-08-05", and overdue_total "613.27" — all decimal strings

#### Scenario: No plan yields zero summary

- GIVEN a patient without a payment plan
- WHEN the summary is requested
- THEN all fields return zero decimal strings

#### Scenario: Not exposed to patient-role users

- GIVEN a patient-role web user
- WHEN they attempt to call the patient-scoped read
- THEN the request MUST fail with 403 Forbidden and their own-record read keeps working unchanged
