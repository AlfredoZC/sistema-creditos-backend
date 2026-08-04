# Tasks: Core Business Modules

**Change**: `core-modules` · **Project**: plataforma-creditos-backend · **Phase**: tasks · **Baseline**: design WU-1..14 (refined, not discarded) · **strict_tdd**: true (RED → GREEN for pure logic; integration specs colocated per module).

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ≈5,500–6,500 (per-slice tally ≈6,460; proposal pre-tasks forecast 4,000–5,000) |
| 400-line budget risk | **High** |
| Chained PRs recommended | **Yes** |
| Suggested split | 16 stacked PRs (thin, ≤~450 lines each except flagged) — see work-unit table |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending (user decides at Review Workload Guard; recommendation: stacked-to-main) |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High

**Per-slice flags** (est. changed lines): PR1 harness ~300 ✅ | PR2 migrations ~600 🚩 **size:exception** (pure DDL: 001+002 atomic files, cannot split cleanly — canonical chained-pr gate) | PR3 common ~400 ✅ | PR4 auth ~450 🚩 borderline | PR5 catalog ~250 ✅ | PR6 surgeries ~550 🚩 sub-split: entities+DTPs commit vs service+spec commit | PR7 doctors ~430 🚩 borderline | PR8 patients ~450 🚩 borderline | PR9 methods+audit ~280 ✅ | PR10 engine ~280 ✅ | PR11 strategies ~320 ✅ | PR12 plans ~600 🚩 sub-split: module+entities vs T1 service+spec | PR13 payments ~700 🚩 sub-split: registration vs confirm/reject service+spec | PR14 audit wiring spec ~150 ✅ | PR15 e2e ~250 ✅ | PR16 docs ~450 🚩 borderline (mechanical tables). **Recommendation**: stacked-to-main with the PR1→PR16 order above; migrations PR (PR2) requires `size:exception`; feature-branch-chain is the alternative if the feature must integrate before any merge to main. All flags are planning estimates, not exact diffs.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| WU-12 | Test bootstrap (harness, `.env.test`, jest config) | PR1 | `npm test -- --runInBand src/test-utils/*.spec.ts` | `docker compose up -d`; `ensureTestDbReady()` on db_creditos_test | delete `src/test-utils/` + revert jest configs |
| WU-11 + 001 | Migrations 002 + 001 (types, DDL, data migration, seed) | PR2 | `npm run migration:run` then `npm run migration:revert` on fresh DB | fresh db_creditos_test; inspect mapped roles + seed rows | `migration:revert` of 002 then 001 |
| WU-2 | Common infra (enums, transformer, validator, handler) | PR3 | `npm test -- src/common` | N/A — pure TS, unit specs only | delete `src/common/{enums,transformers,validators,errors}` |
| WU-1 | Auth refactor (code; 001 already in PR2) | PR4 | `npm run test:e2e -- --testPathPattern=auth` | register/login/register-staff via supertest | revert `src/auth/`, `src/seed/` |
| WU-8a | Surgery catalog | PR5 | `npm run test:e2e -- --testPathPattern=catalog` | catalog CRUD flow | delete `src/surgery-catalog/` |
| WU-8b | Surgeries (T6, T7) | PR6 | `npm run test:e2e -- --testPathPattern=surger` | schedule + status + reassignment flows | delete `src/surgeries/` |
| WU-7 | Doctors (T8) | PR7 | `npm run test:e2e -- --testPathPattern=doctors` | POST /api/doctors atomic flow | delete `src/doctors/` |
| WU-6 | Patients (T9) | PR8 | `npm run test:e2e -- --testPathPattern=patients` | CRUD + link-user flow | delete `src/patients/` |
| WU-5 | Audit module | PR9 | `npm test -- src/audit` | N/A — contract exercised inside tx flows | delete `src/audit/` |
| WU-3 | Financing engine | PR10 | `npm test -- src/payment-plans/financing/*.spec.ts` | N/A — pure math, pinned values | delete `financing/` + revert decimal.js dep |
| WU-4 | Recalculation strategies | PR11 | `npm test -- src/payment-plans/strategies/*.spec.ts` | N/A — pure math | delete `strategies/` |
| WU-9 | Payment methods + plans (T1) | PR9, PR12 | `npm run test:e2e -- --testPathPattern=payment-plan` | plan creation with down payment | delete `src/payment-methods/`, `src/payment-plans/` |
| WU-10 | Payments (T2–T5) | PR13 | `npm run test:e2e -- --testPathPattern=payments` | auto-confirm / confirm / reject / recalc | delete `src/payments/` |
| WU-13 | E2E confirmation flow | PR15 | `npm run test:e2e` | full supertest flow | delete `test/payment-confirmation.e2e-spec.ts` |
| WU-14 | Spanish docs | PR16 | markdown review of table headers | N/A — static docs, source of truth settled | delete `docs/mapeo-es-en.md`, `docs/diccionario-de-datos.md` |

## Phase 1: Test Bootstrap (WU-12)

- [x] 1.1 `load-test-env.ts` + `.env.test` — dotenv config path `.env.test` with `DB_PORT=5439`, `DB_NAME=db_creditos_test`; hard assert `DB_NAME === 'db_creditos_test'`; register as jest `setupFiles` in package.json + `test/jest-e2e.json` (runs before AppModule/TypeOrmModule reads env). AC: harness contract §12 — worker process loads test env first; smoke spec proves DB_NAME guard. Files: `src/test-utils/load-test-env.ts`, `.env.test`, `package.json`, `test/jest-e2e.json`. Deps: none. Evidence: `npm test -- --runInBand` smoke spec green; guard fails loudly on wrong DB_NAME.
- [x] 1.2 `setup-test-db.ts` — `ensureTestDbReady()`: connect `postgres` maintenance DB, `CREATE DATABASE db_creditos_test` if missing, run pending migrations under `pg_advisory_lock(90123)` (idempotent, parallel-safe). AC: fresh DB reaches zero pending migrations; two concurrent invocations serialize. Files: `src/test-utils/setup-test-db.ts`. Deps: 1.1. Evidence: `npm run migration:run` equivalent via helper + `beforeAll` in integration specs.
- [x] 1.3 `truncate.ts` — `TRUNCATE ... RESTART IDENTITY CASCADE` over `information_schema` tables. AC: clean slate between integration tests. Files: `src/test-utils/truncate.ts`. Deps: 1.1. Evidence: integration specs call it in `beforeEach`; no cross-test leakage.
- [x] 1.4 `test-app.ts` — `buildTestingApp()` returning `Test.createTestingModule({ imports: [AppModule] })` + init. AC: integration specs reuse one bootstrap. Files: `src/test-utils/test-app.ts`. Deps: 1.1–1.3. Evidence: first integration spec (auth) boots via helper.

## Phase 2: Common Infrastructure (WU-2)

- [x] 2.1 Nine TS enums + barrel — `UserRole`, `SurgeryStatus`, `SurgeryDoctorRole`, `PaymentPlanType`, `PaymentPlanStatus`, `InstallmentStatus` (incl. `CANCELLED`), `PaymentType`, `PaymentStatus`, `AmortizationMode` + `index.ts` (10 files). AC: string values map 1:1 to PG enums §4 (order = declaration); `installment_status` includes `'cancelled'`. Files: `src/common/enums/*.enum.ts`, `src/common/enums/index.ts`. Deps: none. Evidence: compile; entity decorators reference them.
- [x] 2.2 `decimal.transformer.ts` — `DecimalTransformer` per §5.1 contract: `to` stringifies (null-safe), `from` returns pg numeric string verbatim — never a JS float. AC: money columns round-trip as strings. Files: `src/common/transformers/decimal.transformer.ts` + `index.ts`. Deps: none. Evidence: unit spec (RED first) — `to('913.27')`/`from` round-trip, null/undefined passthrough.
- [x] 2.3 `is-money.validator.ts` — class-validator `IsMoney`: non-negative decimal, ≤2 dp (regex `^\d+(\.\d{1,2})?$`). AC: DTO regex path for D1/D2 (`>= 0`). Files: `src/common/validators/is-money.validator.ts` + `index.ts`. Deps: none. Evidence: unit spec (RED first) — accepts `0.00`, `8000.00`; rejects `-1.00`, `1.234`, `abc`.
- [x] 2.4 `database-error.handler.ts` — shared `handleDatabaseError`: PG 23505 → 409, 23503 → 404/400, 23514 → 400, 22P02 → 400 (AD10; replaces per-service `handleDBErrors`). AC: uniqueness conflicts surface 409 per spec scenarios. Files: `src/common/errors/database-error.handler.ts` + `index.ts`. Deps: none. Evidence: unit spec (RED first) — maps each PG code to correct HTTP status.
- [x] 2.5 Wire `common.module.ts` — export enums/transformer/validator/handler. AC: modules consume shared infra without cycles. Files: MOD `src/common/common.module.ts`. Deps: 2.1–2.4. Evidence: `npm run build` green.

## Phase 3: Database Migrations

- [x] 3.1 `1786000000001-AuthSingleRole.ts` — `CREATE TYPE user_role`; add `role`; data migration `roles[1]` → `role` (`'admin'→'admin'`, `'super-user'→'admin'` (AD9), else → `'patient'`); NOT NULL; drop `roles` + `lastName`; align `id` default `gen_random_uuid()`, varchar lengths; down restores `roles text[]` + `lastName` from `role`. AC: user-auth "Legacy roles migrated to single role" scenario. Files: `src/database/migrations/1786000000001-AuthSingleRole.ts`. Deps: Phase 1. Evidence: `npm run migration:run` on fresh DB + `migration:revert`; SQL spot-check of mapped rows.
- [x] 3.2 `1786000000002-CoreModules.ts` — 8 enum types (incl. `installment_status 'cancelled'`); 10 tables per §5 with FKs (NO ACTION), CHECKs (D1 `paid_amount <= total_amount`, `total_cost >= 0`, payment type integrity XOR rules), UNIQUEs, partial unique index `uq_one_principal_per_surgery`, all §5 indexes; seed `payment_methods` cash/bank_transfer/qr/card; down drops tables (reverse FK order) + types. AC: surgery "Second principal rejected"; payment-processing "Disabled method rejected"; D1/D2 CHECKs. Files: `src/database/migrations/1786000000002-CoreModules.ts`. Deps: Phase 1. Evidence: `migration:run`/`migration:revert` on db_creditos_test; SQL assertions on indexes + seed rows.

## Phase 4: Auth Refactor (WU-1)

- [x] 4.1 `User` entity — `role` enum column replaces `roles: string[]`; drop `lastName`; keep `profile` relation (AD8). AC: user-auth "Single-Role User Model" scenarios. Files: MOD `src/auth/entities/user.entity.ts`. Deps: 2.1, 3.1. Evidence: compile; integration spec.
- [x] 4.2 `valid-roles.ts` → `export { UserRole as ValidRoles }`; `UserRoleGuard` single-role check (`validRoles.includes(user.role)` → else 403); `JwtStrategy`/payload `{id}` untouched. AC: "Guard enforces role", "Missing or invalid token rejected". Files: MOD `src/auth/interfaces/valid-roles.ts`, `src/auth/guards/user-role.guard.ts`. Deps: 2.1. Evidence: integration spec auth — patient on office endpoint → 403; no token → 401.
- [x] 4.3 DTOs + service + controller — `CreateUserDto` {email,password,name} with `forbidNonWhitelisted` rejecting `role` (400); NEW `CreateStaffUserDto` {email,password,name,role} `@IsEnum(UserRole)` restricted to office|admin; `AuthService.create` always role PATIENT, bcrypt(10), keeps profile; `AuthController` adds `POST /auth/users` guarded `@Auth(ValidRoles.admin)`. AC: "Public self-registration yields patient role", "Legacy role values rejected", "Non-admin cannot create office accounts". Files: MOD `src/auth/dto/create-user.dto.ts`, `src/auth/dto/index.ts`, `src/auth/auth.service.ts`, `src/auth/auth.controller.ts`; NEW `src/auth/dto/create-staff-user.dto.ts`. Deps: 2.1, 3.1, 4.1, 4.2. Evidence: integration spec — register → patient; payload role → 400; office creates office → 403; admin creates office → 201.
- [x] 4.4 Seed — `seed-data.ts` emits `role: UserRole` (1 admin + mixed patient/doctor/office); `seed.service.ts` FK-safe wipe (TRUNCATE audit_logs, payments, payment_plans, installments, surgery_doctors, surgeries, surgery_catalog, patients, doctors, users, profiles RESTART IDENTITY CASCADE). AC: seed runs on migrated schema; no lastName/roles references. Files: MOD `src/seed/data/seed-data.ts`, `src/seed/seed.service.ts`. Deps: 3.1, 3.2, 4.1–4.3. Evidence: seed run + `SELECT` role values.

## Phase 5: Patients (WU-6)

- [x] 5.1 Patients module (T9) — entity per §5.3; controller/service CRUD + `POST /api/patients/:id/link-user`; DTOs create/update/link-user; paginated list (shared PaginationDto). T9 tx: set `user_id`; already-linked → 409, nothing persisted. AC: patient-management scenarios — hybrid `user_id` NULL, dup phone 409, dup identity_document 409, link already-linked 409, patient reads own only (403 otherwise), office paginated list. Files: `src/patients/**` (module, controller, service, entity, 3 DTOs, indexes) + `patients.spec.ts`; MOD `src/app.module.ts` (register). Deps: 2.4, 3.2, 4.2. Evidence: integration spec on db_creditos_test (beforeAll `ensureTestDbReady`, truncate between) — all above scenarios + T9 rollback.

## Phase 6: Doctors (WU-7)

- [x] 6.1 Doctors module (T8) — entity per §5.4; `POST /api/doctors` runs ONE tx: insert `users` (role doctor, bcrypt) + `doctors`; license duplicate rolls back the user row; PATCH re-validates license uniqueness; office/admin only; doctor reads own. AC: doctor-management scenarios — atomic create, bcrypt (no plaintext), dup license 409 + user rolled back, patient 403, doctor reads own, license update collision 409. Files: `src/doctors/**` + `doctors.spec.ts`; MOD `src/app.module.ts`. Deps: 2.4, 3.2, 4.2. Evidence: integration spec — T8 rollback proven (no `users` row after 409).

## Phase 7: Surgery Catalog (WU-8a)

- [x] 7.1 Catalog module — entity per §5.5 (CHECK `base_cost >= 0`); CRUD office/admin; GET any authenticated role. AC: surgery-management "Catalog entry created", "Negative base cost rejected" (DTO `IsMoney` + DB CHECK). Files: `src/surgery-catalog/**` + `catalog.spec.ts`; MOD `src/app.module.ts`. Deps: 2.3, 2.4, 3.2, 4.2. Evidence: integration spec — create + read by patient; `-1.00` → 400.

## Phase 8: Surgeries (WU-8b)

- [x] 8.1 Surgeries module (T6, T7) — entities Surgery + SurgeryDoctor (decorator partial unique index AD11 + explicit DDL in 3.2); DTOs create (optional `totalCost` defaults to catalog `base_cost` — D2), update (reject `total_cost` edit after a plan exists → 409), status, assign-doctor, reassign-principal. T6: status change + audit `surgery.status_changed` in one tx. T7: demote current principal → promote new, one tx (per-statement partial index order). AC: surgery-management scenarios — scheduled default status, status transition audited in-tx, invalid status 400, second principal rejected (partial index), reassignment atomic (never 0 or 2 principals), same doctor twice rejected. Files: `src/surgeries/**` (2 entities, 5 DTOs) + `surgeries.spec.ts`; MOD `src/app.module.ts`. Deps: 2.4, 3.2, 4.2, 5.1, 6.1, 7.1, 9.2 (audit). Evidence: integration spec — T6 audit row in same tx; T7 demote-then-promote ordering; duplicate-role insert → 23505 → 409.

## Phase 9: Payment Methods + Audit (WU-5, WU-9a)

- [x] 9.1 Payment methods module — entity per §5.10; `GET /api/payment-methods` returns enabled only (any auth). AC: read side of "Payment Methods Catalog". Files: `src/payment-methods/**`; MOD `src/app.module.ts`. Deps: 2.1, 3.2, 4.2. Evidence: integration spec — seed rows present, disabled hidden.
- [x] 9.2 Audit module — `AuditLog` entity per §5.12 (append-only, no FK on record_id, indexes user_id/created_at) + `AuditService.log(manager, entry)` using the transaction's EntityManager; actions vocabulary `payment_plan.created|payment.confirmed|payment.rejected|payment_plan.recalculated|surgery.status_changed`. AC: audit-logging "Audit Entry Shape" + system action attribution (user_id NULL). Files: `src/audit/**`; MOD `src/app.module.ts`. Deps: 2.1, 3.2. Evidence: unit spec for service contract; entries verified inside tx flows (Phases 8, 12, 13).

## Phase 10: Financing Engine (WU-3, strict TDD)

- [x] 10.1 RED — `financing-engine.spec.ts` with PINNED values (§6.2): base P=10,000.00 i=2% n=10 → A=1,113.27, lines 1–9 = 1,113.27 (913.27/200.00, 931.54/181.73, 950.17/163.10 …), line 10 = 1,091.39/21.83, Σ principal 10,000.00, Σ interest 1,132.65, Σ total 11,132.65; upfront 7,000 n=1 → single line 7,000.00/0.00; `i=0` → P/n; EOM clamp 2026-01-31 → k1 2026-02-28, k3 2026-04-30; `computeInstallment` formula. AC: payment-plans "Rounding remainder absorbed", "Reference schedule", "Upfront plan", "End-of-month clamping". Files: NEW `src/payment-plans/financing/financing-engine.spec.ts`. Deps: Phase 1. Evidence: spec fails before implementation (strict TDD).
- [x] 10.2 GREEN — `schedule-line.ts` + `financing-engine.ts` (pure, decimal.js ^10.4.3 fixed-point, `ROUND_HALF_UP` per line, LAST line principal = remaining balance unconditionally, `addMonthsClamped` on (y,m,d) with Date.UTC); strategy contract `src/payment-plans/strategies/installment-recalculation.strategy.ts` (design §7 — concrete strategies land in 11.2). AC: all pinned values reproduced exactly (11,132.65). Files: NEW `src/payment-plans/financing/schedule-line.ts`, `financing-engine.ts`, `src/payment-plans/strategies/installment-recalculation.strategy.ts`; MOD `package.json` (decimal.js dep). Deps: 10.1. Evidence: `npm test -- src/payment-plans/financing/*.spec.ts` green.

## Phase 11: Recalculation Strategies (WU-4, strict TDD)

- [x] 11.1 RED — strategy specs with pinned values (§7): reduce_installment — balance 5,155.19 @2% n=8 → A=**703.73** (algorithm-exact; doc's 703.74 is an ACCEPTED one-cent artifact), lines 1–7 at 703.73, line 8 = **703.76** (absorbs remainder), Σ 5,629.87; reduce_term — keep A=1,113.27 → 4×1,113.27 + final fractional 1,011.50 (991.67 + 19.83), 3 surplus rows `cancelled` in place; balance '0.00' → cancel ALL pending; factory `getFor` falls back to reduce_installment. AC: payment-plans "Reduce installment (doc Option A)", "Reduce term (doc Option B)". Files: NEW `src/payment-plans/strategies/*.spec.ts`. Deps: 10.2. Evidence: specs fail before implementation.
- [x] 11.2 GREEN — `installment-recalculation.strategy.ts` interface + `reduce-installment.recalculation.strategy.ts` + `reduce-term.recalculation.strategy.ts` + `recalculation-strategy.factory.ts` + `index.ts` (pure; persistence is the caller's job — AD6; cancelled rows never deleted). AC: strategy contract §7 incl. edge cases. Files: NEW `src/payment-plans/strategies/`. Deps: 11.1, 10.2. Evidence: `npm test -- src/payment-plans/strategies/*.spec.ts` green.

## Phase 12: Payment Plans (WU-9b)

- [x] 12.1 Payment plans module (T1) — entities per §5.8/§5.9 (aggregate owns installments; UNIQUE surgery_id; CHECKs); DTO; service `POST /api/payment-plans` in ONE `dataSource.transaction`: validate surgery/plan/catalog → plan row + generated schedule installments + (if down_payment > 0) down_payment payment auto-confirmed (method validated, enabled only) + audit `payment_plan.created` (same manager); reads: plan detail, installments with derived `overdue` flag (read-only, never a write); patient sees own plan only. T1 AC: payment-plans "Credit plan with down payment" (financed_amount = total_cost − down_payment, schedule over financed only), "Second plan for same surgery rejected" 409, "Amortization exceeding balance rejected" (no partial persist), plan lifecycle evaluation (completed ⇔ balance 0 + all non-cancelled paid; delinquent ⇔ overdue pending/partial; active otherwise); audit-logging "Plan creation audited" (exactly one entry, action `payment_plan.created`, record_id + new_data with schedule). Files: `src/payment-plans/**` (module, controller, service, 2 entities, DTO) + `payment-plans.spec.ts`; MOD `src/app.module.ts`. Deps: 2.1–2.4, 3.2, 5.1, 7.1, 9.1, 9.2, 10.2, 11.2. Evidence: integration spec — T1 tx (rollback on failure leaves no plan/installments/payment/audit), down-payment flow, 409 cases, lifecycle transitions.

## Phase 13: Payments (WU-10)

- [x] 13.1 Payments module (T2–T5) — entity per §5.11 (all CHECKs); DTO; service + controller. T2 office/admin register → auto-confirm in tx (reuse `applyPaymentEffects`): lock plan FOR UPDATE → apply effects by type → evaluate plan → audit `payment.confirmed`. T3 patient register → row `pending_confirmation` only (no effects, no audit). T4 confirm (`POST /:id/confirm`, office/admin): lock payment → assert pending (else 409 terminal) → lock plan FOR UPDATE → assert plan active/delinquent → switch type: down_payment (no effect), installment_payment (assert `paid_amount + amount <= total_amount` else 409 D1; accumulate; status partial/paid; `outstanding_balance -= creditPrincipal(paid_after) − creditPrincipal(paid_before)` with `creditPrincipal = HALF_UP(principal × paid / total)`), principal_amortization (assert `amount <= outstanding_balance` else 409; subtract; factory recalculation; persist rows in place) → evaluate lifecycle → status confirmed → audit(s) (`payment.confirmed`; + `payment_plan.recalculated` when amortization, with pre/post state). T5 reject (office/admin): lock payment → validate pending → `rejected`, audit `payment.rejected`; side-effect free. AC: payment-processing scenarios — "Office counter payment auto-confirms", "Patient receipt upload stays pending", "Type/constraint violations rejected" (400, nothing persisted), "Rejection is side-effect free", "Patient cannot confirm" (403), "Terminal states" (409), "Partial payment", "Installment fully paid", "Overdue derived at read"; D1 overpayment 409; payment-plans "Amortization exceeding balance" + recalc scenarios; "Confirmation failure rolls back everything" (payment, balance, installments, audit all unchanged); audit-logging "Recalculation audited" + "Actor attribution". Files: `src/payments/**` (module, controller, service, entity, DTO) + `payments.spec.ts`; MOD `src/app.module.ts`. Deps: 9.1, 9.2, 11.2, 12.1. Evidence: integration spec on db_creditos_test — T2 auto-confirm effects, T3 pending, T4 full confirm flow incl. overpayment 409 + rollback assertion, T5 rejection with audit, terminal 409s.

## Phase 14: Audit Wiring Verification

- [x] 14.1 Audit-logging integration spec — end-to-end assertions across flows: exactly one `payment_plan.created` entry; `payment_plan.recalculated` entry with previous_data (pre-recalc balance + installments) and new_data; `payment.rejected` actor attribution (user_id = office id, previous/new status); rollback leaves NO audit entry; system action user_id NULL. AC: audit-logging "In-Transaction Audit Entries" scenarios. Files: NEW `src/audit/audit-wiring.spec.ts` (integration spec under src/ per module-colocated convention; runs under `npm test`/`npm run test:integration`). Deps: 12.1, 13.1. Evidence: `npm run test:integration` green (270/270 incl. 5 new wiring tests; wiring matched the spec as-is, no service fix required).

## Phase 15: E2E Confirmation Flow (WU-13)

- [x] 15.1 `test/payment-confirmation.e2e-spec.ts` — supertest flow on db_creditos_test: register office → create catalog → register patient → schedule surgery → create plan → register principal_amortization (patient pending) → office confirms → assert outstanding_balance/schedule recomputed + audit rows + 200 responses; plus a rejection leg. AC: proposal success criteria "e2e confirmation/recalculation flow passes on db_creditos_test"; payment-processing "Transaction Boundaries" end-to-end. Files: NEW `test/payment-confirmation.e2e-spec.ts`. Deps: 14.1. Evidence: `npm run test:e2e` green.

## Phase 16: Spanish Docs (WU-14 — LAST, source of truth = final entities + migrations)

- [x] 16.1 `docs/mapeo-es-en.md` — per-table mapping tables `Tabla ES → Tabla EN`, `Columna ES → Columna EN`, enum values `Valor ES → Valor EN`; locked next-phase WhatsApp tables (message_templates, whatsapp_dispatches, bot_conversations, bot_messages) listed with EN names. AC: design §13 structure; matches final schema exactly. Files: NEW `docs/mapeo-es-en.md`. Deps: 3.1, 3.2 + all entity tasks. Evidence: cross-check every table/column in migrations 001/002.
- [x] 16.2 `docs/diccionario-de-datos.md` — one section per table; rows with EXACT headers `Elemento | Tipo de Dato | Requerido | Descripción`; `Requerido` = Sí/No; `Tipo de Dato` from final DDL (e.g. `NUMERIC(10,2)`, `user_role`); [PK]/[FK] markers, defaults, enums. AC: design §13 structure; headers verbatim. Files: NEW `docs/diccionario-de-datos.md`. Deps: 16.1. Evidence: header line matches spec exactly; row count per table equals final DDL columns.
