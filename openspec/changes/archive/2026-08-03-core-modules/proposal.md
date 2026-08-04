# Proposal: Core Business Modules

## Intent

Deliver the platform's core domain — patients, doctors, surgeries, payment plans (French amortization), and payments with a confirmation workflow — on an English PostgreSQL schema with native enums. `users.roles text[]` is refactored to the single-role model; money movement requires auditability from day one.

## Scope

### In Scope
- New modules: `patients`, `doctors`, `surgery-catalog`, `surgeries` (+`surgery_doctors`), `payment-plans`, `payment-methods`, `payments`, thin `audit`.
- ES→EN schema translation per the locked naming map; 9 native enum types (values locked).
- French amortization: `P*i/(1-(1+i)^-n)`, interest on outstanding principal, HALF_UP per line, last installment absorbs remainder; down payment supported.
- Strategy-pattern recalculation on payment CONFIRMATION in one transaction (`SELECT FOR UPDATE`); `reduce_term` cancels surplus installments, never deletes.
- Auth refactor: single `role user_role`; `ValidRoles` realigned; JWT payload `{id}` unchanged.
- Versioned migrations ALTER `users` + CREATE tables/enums; `gen_random_uuid()` standard.
- TDD bootstrap: unit specs (pure calculator/strategies); `db_creditos_test` (port 5439) for transactional flows.
- Spanish docs in `docs/`: ES↔EN mapping; data dictionary with exact headers Elemento | Tipo de Dato | Requerido | Descripción.

### Out of Scope
- WhatsApp bot tables (`message_templates`, `whatsapp_dispatches`, `bot_conversations`, `bot_messages`) — next phase; English names locked in the mapping doc.
- Photos on patients/doctors; Init migration squash; TypeORM subscribers.

## Capabilities

### New Capabilities
- `patient-management`: CRUD, nullable `user_id` (hybrid model), unique phone (bot identity).
- `doctor-management`: CRUD, mandatory user link, unique professional license.
- `surgery-management`: catalog, surgeries, doctor assignments, one-principal invariant.
- `payment-plans`: creation, French schedule generation, lifecycle, amortization recalculation.
- `payment-processing`: registration, confirmation workflow, receipts, method seeds.
- `audit-logging`: explicit in-transaction audit entries.

### Modified Capabilities
- `user-auth`: role array → single `user_role` enum; `ValidRoles` → patient/doctor/office/admin (no main spec exists yet; spec phase seeds it).

## Approach

PaymentPlan aggregate owns installments. Pure `generateFrenchAmortizationSchedule()` (no DB deps) enables strict TDD; strategy registry keyed by `amortization_mode` (`reduce_installment` DEFAULT, `reduce_term`). `confirmPayment()` runs one QueryRunner transaction: lock plan FOR UPDATE → confirm → reduce `outstanding_balance` (principal only) → recalculate pending installments in place → `AuditService.log()` in the same transaction. Confirmation rule locked: office-registered payments auto-confirm at registration; patient receipt uploads stay `pending_confirmation` until office confirms. Numeric columns use a decimal string transformer — never JS floats.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/auth` | Modified | role enum, guards, DTOs, seed |
| 8 new modules | New | entities, services, controllers, DTOs |
| `src/database/migrations` | New | ALTER users + CREATE tables/enums |
| `docs/` | New | two Spanish deliverables |
| `src/profile` | Unchanged | web-user photo only |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Auth refactor breaks flows | Med | JWT untouched; migration maps `roles[1]`→`role` |
| Enum rigidity | Med | values locked now; add-only via `ALTER TYPE` |
| Concurrent amortization races | Low | `SELECT FOR UPDATE` on plan row |
| Diff exceeds 400-line review budget | High | est. ~4,000–5,000 changed lines (code + specs + migrations + docs); orchestrator consults user on delivery strategy |

## Rollback Plan

Reversible migrations (`migration:revert`); auth revert restores `roles text[]` from `role`. Dev-only DB: worst case rebuild the container and rerun migrations. Code reverts via git.

## Dependencies

- PostgreSQL 18 (port 5439); existing cloudinary module for receipts; locked exploration naming map.

## Success Criteria

- [ ] `npm test` green: calculator + both strategies unit-tested
- [ ] e2e confirmation/recalculation flow passes on `db_creditos_test`
- [ ] Migrations run clean from Init on a fresh DB
- [ ] Both Spanish docs delivered in `docs/`
- [ ] No `any` in new code; DB transactions on money-touching endpoints
