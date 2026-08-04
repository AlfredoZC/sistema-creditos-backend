# Payment Plans Specification

## Requirements

### Requirement: Money Representation and Rounding

Money MUST be fixed-point decimal, never JS floats: `numeric(10,2)` columns use a decimal string transformer on entities; the financing engine uses fixed-point arithmetic. Each schedule line MUST round HALF_UP to 2 decimals; the LAST installment MUST absorb the rounding remainder so the schedule sums exactly.

#### Scenario: Rounding remainder absorbed by the last installment

- GIVEN P=10,000.00, i=2%, n=10
- WHEN the schedule is generated
- THEN every line is rounded HALF_UP to 2 decimals, the last installment absorbs the rounding remainder, and the schedule sums exactly to 11,132.65

### Requirement: French Amortization Schedule Generation

Schedules MUST use the French fixed-installment formula `installment = P*i/(1-(1+i)^-n)` with interest on the outstanding principal, split into `principal_amount`/`interest_amount`. For `i=0` the installment MUST be `principal/n` with zero interest. The calculator MUST be pure (no DB deps). `upfront` plans MUST have `installment_count=1` and zero interest.

#### Scenario: Reference schedule (10,000 @ 2% x 10)

- GIVEN P=10,000.00, i=2%, n=10
- WHEN the schedule is generated
- THEN the installment is 1,113.27; line 1 = 913.27/200.00, line 2 = 931.54/181.73, line 3 = 950.17/163.10; patient total 11,132.65

#### Scenario: Upfront plan schedule

- GIVEN P=7,000.00, i=0 (upfront plan), n=1
- WHEN the schedule is generated
- THEN there is exactly one installment of 7,000.00 with interest_amount 0.00

### Requirement: Installment Due-Date Cadence

The due_date of installment k MUST equal `start_date + k` calendar months; day overflow MUST clamp to the target month's last day.

#### Scenario: End-of-month clamping

- GIVEN start_date 2026-01-31
- WHEN the schedule is generated
- THEN installment 1 due_date is 2026-02-28 and installment 3 due_date is 2026-04-30

### Requirement: Plan Creation and Down Payment

Plans live in `payment_plans` (UNIQUE `surgery_id`: one plan per surgery) with `type` ('upfront','credit'), `monthly_interest_rate` DEFAULT 2.00, `installment_count` > 0, `status` ('active','completed','delinquent','cancelled') DEFAULT 'active'. `financed_amount = surgery.total_cost - down_payment`; the schedule MUST be generated over `financed_amount` only. When `down_payment > 0`, a `down_payment` payment MUST be registered in the same transaction. Plan + schedule + down payment + audit MUST run in ONE DB transaction.

#### Scenario: Credit plan with down payment

- GIVEN a surgery with total_cost 10,000.00
- WHEN a plan is created with down_payment 3,000.00, n=10, i=2%
- THEN financed_amount is 7,000.00, the schedule is over 7,000.00, and the down payment is registered atomically

#### Scenario: Second plan for same surgery rejected

- GIVEN a surgery that already has a plan
- WHEN another plan is created for it
- THEN the request MUST fail with 409 Conflict

`outstanding_balance` MUST track principal only (capital vivo): it equals `financed_amount` at creation; a confirmed `principal_amortization` subtracts its full amount; a confirmed `installment_payment` subtracts only the principal portion of the covered installment. It MUST never go below zero.

#### Scenario: Amortization exceeding balance rejected

- GIVEN a plan with outstanding_balance 5,155.19
- WHEN a principal_amortization of 6,000.00 is confirmed
- THEN the operation MUST fail with no balance or schedule change persisted

### Requirement: Amortization Recalculation Strategies

Recalculation MUST trigger ONLY on confirmation of a `principal_amortization` payment, inside the confirmation transaction with `SELECT FOR UPDATE` on the plan row. Only PENDING installments are recalculated in place (stable IDs, never DELETE); partial/paid ones are untouched. `installment_status` MUST include 'cancelled' (extends the exploration enum) so surplus rows can be cancelled in place. Strategy selected by the payment's `amortization_mode`:

- `reduce_installment` (DEFAULT): keep remaining term; recompute a lower installment over the new balance and remaining pending installments.
- `reduce_term`: keep the installment amount; recompute the count; a final fractional installment settles the remainder; surplus trailing pending installments MUST be cancelled IN PLACE, never deleted.

#### Scenario: Reduce installment (doc Option A)

- GIVEN the reference plan with installments 1–2 paid, outstanding_balance 8,155.19, 8 pending
- WHEN a 3,000.00 amortization with mode `reduce_installment` is confirmed
- THEN outstanding_balance becomes 5,155.19 and the 8 pending installments recompute to 703.73 each, with the last installment absorbing the remainder (703.76)

#### Scenario: Reduce term (doc Option B)

- GIVEN the same state
- WHEN the amortization uses mode `reduce_term`
- THEN pending installments keep total 1,113.27 (≈4.6 installments: 4 full + 1 fractional final) and surplus trailing pending installments become 'cancelled', rows preserved

### Requirement: Plan Lifecycle

A plan MUST become 'completed' when all non-cancelled installments are paid AND `outstanding_balance = 0`; it MUST be 'delinquent' while any uncancelled installment is overdue, returning to 'active' when none remain. Cancelled installments MUST NOT count toward completion or delinquency.

#### Scenario: Plan completion

- GIVEN a plan whose last non-cancelled installment is confirmed paid with outstanding_balance 0.00
- WHEN the confirmation transaction commits
- THEN the plan status is 'completed'

#### Scenario: Delinquent while an installment is overdue

- GIVEN a plan with installment #3 due yesterday and status 'pending'
- WHEN plan status is evaluated
- THEN the plan is 'delinquent'
- AND once that installment is fully paid and no other installment is overdue, the plan returns to 'active'
