# Design: Core Business Modules

**Change**: `core-modules` — patients, doctors, surgery catalog + surgeries, payment plans (French amortization), payment processing, audit logging, and the single-role auth refactor on an English PostgreSQL schema with native enums.

**Technical approach**: 8 new NestJS feature modules following the existing convention (module/controller/service + `entities/` + `dto/` barrels, `@ApiProperty`, global `/api` prefix, whitelist ValidationPipe), a pure financing engine (decimal.js fixed-point, no DB deps, strict-TDD-first), strategy-pattern recalculation triggered inside one `SELECT FOR UPDATE` confirmation transaction, an explicit in-transaction `AuditService.log()` (no TypeORM subscribers), and two versioned migrations (auth refactor; core tables + enums + seed). The `Init` migration stays untouched.

---

## 1. Resolved Business Decisions

### Decision D1: Overpayment on `installment_payment` — REJECT with 409 Conflict

**Choice**: A confirmed `installment_payment` whose `paid_amount + amount` would exceed the installment's `total_amount` is rejected with `409 Conflict` ("amount exceeds the installment's remaining balance; use a principal_amortization for extra payments"). Enforced in the service AND by a new DB CHECK `paid_amount <= total_amount` on `installments`.

**Alternatives considered**:
- *Allow and clamp* — silently cap the credit. Rejected: the surplus would float unallocated, corrupting the schedule-sum invariant and the completion rule (`completed` ⇔ all non-cancelled paid AND `outstanding_balance = 0`).
- *Allow and roll surplus into principal_amortization* — implicit, surprising side effect; the patient's intent (reduce term vs installment) is unknown without an explicit `amortization_mode`.

**Rationale**: `paid_amount` is a derivation accumulator (`pending` → `partial` → `paid` thresholds); exceeding `total_amount` breaks its semantics and the proportional principal-credit formula (Section 7.3) which assumes `paid_amount <= total_amount`. `principal_amortization` is the explicit, auditable path for extra money and triggers recalculation — the correct business flow. A clear conflict error (not silent capping) keeps the ledger honest.

### Decision D2: `surgeries.total_cost` — default from `surgery_catalog.base_cost`, operator override allowed at creation

**Choice**: `CreateSurgeryDto.totalCost` is optional; when omitted the service sets `total_cost = surgery_catalog.base_cost`. When provided it overrides per-patient pricing. Both paths enforce `>= 0` (DTO regex + DB CHECK). After a `payment_plans` row exists for the surgery, `PATCH total_cost` is rejected with `409 Conflict` (the plan's `financed_amount` derives from it and would desync).

**Alternatives considered**:
- *Strictly derive from catalog* — clinics cannot discount per-patient pricing (complexity, negotiation).
- *Always require explicit total_cost* — forces duplication of the catalog reference price.

**Rationale**: Catalog = reference price; surgery = the priced event. Defaulting from `base_cost` with override keeps the happy path single-field while preserving flexibility, and the no-plan-edit rule protects the financing invariant.

---

## 2. Architecture Decisions (summary)

| # | Decision | Choice | Alternatives rejected |
|---|----------|--------|----------------------|
| AD1 | Installments ownership | `PaymentPlan` aggregate owns `installments` inside `payment-plans` (no standalone installments module) | Standalone module → cross-module transactional writes on every recalculation |
| AD2 | Money representation | `numeric(10,2)` columns map to **string** in TS via a shared `DecimalTransformer`; engine arithmetic in **decimal.js** (fixed-point, `ROUND_HALF_UP`) | JS floats (never — precision); bigint-cents (hand-rolled rational exponentiation + rounding, more review surface for the same guarantee) |
| AD3 | Audit | Thin `audit` module, explicit `AuditService.log(manager, entry)` INSIDE business transactions | TypeORM subscribers (implicit, untestable, bypassable — proposal out-of-scope); deferral (money needs traceability day one) |
| AD4 | Module dependency direction | `payments` imports `payment-plans` (strategy factory). `payment-plans` does **not** import `payments`; the down-payment row is inserted via `TypeOrmModule.forFeature([Payment])` inside the plan-creation transaction | Circular `forwardRef` (code smell); payment-plans calling PaymentsService (cycle) |
| AD5 | Recalculation trigger | Only on confirmation of `principal_amortization`, inside the confirmation transaction, plan row locked `FOR UPDATE` | At registration (payments start `pending_confirmation`); outside transactions (races) |
| AD6 | Strategy persistence | Strategies are **pure** (return recomputed line state); the caller persists in the transaction | Strategies writing via repositories (couples math to DB, kills unit TDD) |
| AD7 | `users.lastName` | Dropped (column, DTO field, seed) — the ES source schema and locked naming map have no lastName | Keeping it (drift from source schema) |
| AD8 | `users.profileId` | **Kept** — proposal pins `src/profile` unchanged; profile creation in `register` stays | Dropping → cascades into profile module (out of scope) |
| AD9 | Legacy `super-user` role | Migrates to `'admin'` (privilege-preserving; never downgrade in a data migration) | `'office'` (downgrade risk) |
| AD10 | Error mapping | 409 Conflict for all state/uniqueness conflicts; 400 for validation; shared `handleDatabaseError` helper | Existing per-service ad-hoc `handleDBErrors` (maps 23505 → 400, contradicting spec's 409 scenarios) |
| AD11 | Partial unique index | Represented in TypeORM via `@Index('uq_one_principal_per_surgery', ['surgeryId'], { unique: true, where: "role = 'principal'" })` AND created explicitly in the migration | TypeORM `ManyToMany` sugar (loses role column, partial index, per-row ops) |

---

## 3. Module Topology

```
src/
├── app.module.ts                      (MOD — register new modules)
├── common/
│   ├── transformers/decimal.transformer.ts + index.ts      (NEW)
│   ├── validators/is-money.validator.ts + index.ts         (NEW)
│   └── errors/database-error.handler.ts + index.ts         (NEW)
├── auth/                               (MOD — single role, see §9)
├── audit/                              (NEW)
│   ├── audit.module.ts / audit.service.ts
│   └── entities/audit-log.entity.ts + index.ts
├── patients/                           (NEW)
│   ├── patients.module.ts / patients.controller.ts / patients.service.ts
│   ├── entities/patient.entity.ts + index.ts
│   └── dto/create-patient.dto.ts / update-patient.dto.ts / link-user.dto.ts + index.ts
├── doctors/                            (NEW)
│   ├── doctors.module.ts / doctors.controller.ts / doctors.service.ts
│   ├── entities/doctor.entity.ts + index.ts
│   └── dto/create-doctor.dto.ts / update-doctor.dto.ts + index.ts
├── surgery-catalog/                    (NEW)
│   ├── surgery-catalog.module.ts / controller / service
│   ├── entities/surgery-catalog-entry.entity.ts + index.ts
│   └── dto/create-catalog-entry.dto.ts / update-catalog-entry.dto.ts + index.ts
├── surgeries/                          (NEW)
│   ├── surgeries.module.ts / controller / service
│   ├── entities/surgery.entity.ts + surgery-doctor.entity.ts + index.ts
│   └── dto/create-surgery.dto.ts / update-surgery.dto.ts / update-surgery-status.dto.ts
│       / assign-doctor.dto.ts / reassign-principal.dto.ts + index.ts
├── payment-plans/                      (NEW — aggregate owns installments + engine + strategies)
│   ├── payment-plans.module.ts / controller / service
│   ├── entities/payment-plan.entity.ts + installment.entity.ts + index.ts
│   ├── dto/create-payment-plan.dto.ts + index.ts
│   ├── financing/schedule-line.ts + financing-engine.ts + financing-engine.spec.ts
│   └── strategies/installment-recalculation.strategy.ts
│       / reduce-installment.recalculation.strategy.ts
│       / reduce-term.recalculation.strategy.ts
│       / recalculation-strategy.factory.ts + index.ts + *.spec.ts
├── payment-methods/                    (NEW — leaf)
│   ├── payment-methods.module.ts / controller / service
│   └── entities/payment-method.entity.ts + index.ts
├── payments/                           (NEW — imports payment-plans)
│   ├── payments.module.ts / controller / service
│   ├── entities/payment.entity.ts + index.ts
│   └── dto/create-payment.dto.ts + index.ts
├── database/migrations/
│   ├── 1785621997266-Init.ts           (UNTOUCHED)
│   ├── 1786000000001-AuthSingleRole.ts (NEW)
│   └── 1786000000002-CoreModules.ts    (NEW)
├── test-utils/                         (NEW — test bootstrap, see §12)
│   ├── load-test-env.ts / setup-test-db.ts / truncate.ts / test-app.ts
└── seed/                               (MOD — single role, FK-safe wipe)
```

Shared TS enums live in `src/common/enums/` (9 files + `index.ts`) — cross-module vocabulary (e.g. `amortization_mode` used by both `payments` and `payment-plans`) must not create module cycles.

---

## 4. PostgreSQL Enums (9 native types)

Created in the migrations (`user_role` in `001`, the other 8 in `002`). TS enums map 1:1 by string value, declared in `src/common/enums/*.enum.ts`, used in entity decorators as `@Column({ type: 'enum', enum: XxxEnum })`.

| # | PG type | Values (order = enum declaration) | TS enum | Notes |
|---|---------|-----------------------------------|---------|-------|
| 1 | `user_role` | `'patient','doctor','office','admin'` | `UserRole` | From legacy `paciente/medico/oficina/admin` |
| 2 | `surgery_status` | `'scheduled','performed','cancelled'` | `SurgeryStatus` | DEFAULT `'scheduled'` |
| 3 | `surgery_doctor_role` | `'principal','assistant','anesthesiologist'` | `SurgeryDoctorRole` | DEFAULT `'principal'` |
| 4 | `payment_plan_type` | `'upfront','credit'` | `PaymentPlanType` | `'cash'` rejected (collides with method seed) |
| 5 | `payment_plan_status` | `'active','completed','delinquent','cancelled'` | `PaymentPlanStatus` | DEFAULT `'active'` |
| 6 | `installment_status` | `'pending','partial','paid','overdue','cancelled'` | `InstallmentStatus` | **10th value**: `'cancelled'` extends the exploration enum — surplus rows are cancelled in place, never deleted |
| 7 | `payment_type` | `'down_payment','installment_payment','principal_amortization'` | `PaymentType` | |
| 8 | `payment_status` | `'pending_confirmation','confirmed','rejected'` | `PaymentStatus` | DEFAULT `'pending_confirmation'` |
| 9 | `amortization_mode` | `'reduce_installment','reduce_term'` | `AmortizationMode` | XOR with `payment_type` |

Enum rigidity: values are locked now; future additions only via `ALTER TYPE ... ADD VALUE`.

---

## 5. Entities

All money columns: `@Column({ type: 'numeric', precision: 10, scale: 2, transformer: decimalTransformer })` → TS `string`. Convention: `decimalTransformer` instance exported from `common/transformers`.

### 5.1 DecimalTransformer (contract)

```ts
// src/common/transformers/decimal.transformer.ts
import { ValueTransformer } from 'typeorm';

export class DecimalTransformer implements ValueTransformer {
  to(value?: string | number | null): string | null | undefined {
    return value === null || value === undefined ? value : String(value); // pg numeric accepts string
  }
  from(value: string | null | undefined): string | null | undefined {
    return value; // pg ALWAYS returns numeric as string — never a JS float
  }
}
export const decimalTransformer = new DecimalTransformer();
```

### 5.2 Users (MODIFIED — `src/auth/entities/user.entity.ts`)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `email` | `@Column('text', { unique: true })` | normalized lowercase (existing hooks) |
| `password` | `@Column('text', { select: false })` | bcrypt(10) |
| `name` | `@Column('text')` | |
| `role` | `@Column({ type: 'enum', enum: UserRole })` | **replaces `roles: string[]`** |
| `isActive` | `@Column('bool', { default: true })` | |
| `profile` | `@OneToOne(() => Profile) @JoinColumn()` | kept (AD8) |
| ~~`roles`~~ | removed | |
| ~~`lastName`~~ | removed | (AD7) |

### 5.3 Patients (`src/patients/entities/patient.entity.ts` — table `patients`)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `userId` | `@Column('uuid', { nullable: true, unique: true })` + `@OneToOne(() => User) @JoinColumn({ name: 'user_id' })` | NULL = hybrid model, no web account |
| `identityDocument` | `@Column('varchar', { length: 20, unique: true })` | bot 2nd factor |
| `firstName` | `@Column('varchar', { length: 50 })` | |
| `paternalLastName` | `@Column('varchar', { length: 50 })` | |
| `maternalLastName` | `@Column('varchar', { length: 50, nullable: true })` | |
| `birthDate` | `@Column('date', { nullable: true })` | |
| `address` | `@Column('varchar', { length: 100, nullable: true })` | |
| `phone` | `@Column('varchar', { length: 50, unique: true })` | bot primary identity |

### 5.4 Doctors (`src/doctors/entities/doctor.entity.ts` — table `doctors`)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `userId` | `@Column('uuid', { unique: true })` + `@OneToOne(() => User) @JoinColumn({ name: 'user_id' })` | NOT NULL — mandatory web account |
| `specialty` | `@Column('text')` | |
| `professionalLicense` | `@Column('text', { unique: true })` | |

### 5.5 SurgeryCatalogEntry (`surgery-catalog` — table `surgery_catalog`)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `name` | `@Column('varchar', { length: 50 })` | |
| `description` | `@Column('text', { nullable: true })` | |
| `baseCost` | `numeric(10,2)` transformer | CHECK `base_cost >= 0` |

### 5.6 Surgery (`surgeries` — table `surgeries`)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `patientId` | `@Column('uuid')` + `@ManyToOne(() => Patient) @JoinColumn({ name: 'patient_id' })` | |
| `surgeryCatalogId` | `@Column('uuid')` + `@ManyToOne(() => SurgeryCatalogEntry) @JoinColumn({ name: 'surgery_catalog_id' })` | |
| `scheduledDate` | `@Column('date')` | |
| `totalCost` | `numeric(10,2)` transformer | CHECK `>= 0`; default = catalog `base_cost` (D2) |
| `status` | `@Column({ type: 'enum', enum: SurgeryStatus, default: SurgeryStatus.SCHEDULED })` | |
| `notes` | `@Column('text', { nullable: true })` | |

### 5.7 SurgeryDoctor (`surgeries` — table `surgery_doctors`, explicit join entity)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `surgeryId` | `@Column('uuid')` + `@ManyToOne(() => Surgery) @JoinColumn({ name: 'surgery_id' })` | |
| `doctorId` | `@Column('uuid')` + `@ManyToOne(() => Doctor) @JoinColumn({ name: 'doctor_id' })` | |
| `role` | `@Column({ type: 'enum', enum: SurgeryDoctorRole, default: SurgeryDoctorRole.PRINCIPAL })` | |
| — | `@Index('uq_surgery_doctors_surgery_doctor', ['surgeryId', 'doctorId'], { unique: true })` | UNIQUE(surgery_id, doctor_id) |
| — | `@Index('uq_one_principal_per_surgery', ['surgeryId'], { unique: true, where: "role = 'principal'" })` | partial unique index (AD11) |

### 5.8 PaymentPlan (`payment-plans` — table `payment_plans`)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `surgeryId` | `@Column('uuid', { unique: true })` + `@OneToOne(() => Surgery) @JoinColumn({ name: 'surgery_id' })` | one plan per surgery |
| `type` | `@Column({ type: 'enum', enum: PaymentPlanType })` | upfront = 1 installment, 0% |
| `downPayment` | `numeric(10,2)` transformer, default `'0.00'` | |
| `financedAmount` | `numeric(10,2)` transformer | = surgery.total_cost − down_payment, > 0 (service) |
| `monthlyInterestRate` | `numeric(10,2)` transformer, default `'2.00'` | |
| `installmentCount` | `@Column('int')` | CHECK `> 0` |
| `startDate` | `@Column('date')` | |
| `outstandingBalance` | `numeric(10,2)` transformer | principal only ("capital vivo"), never < 0 |
| `status` | `@Column({ type: 'enum', enum: PaymentPlanStatus, default: PaymentPlanStatus.ACTIVE })` | |
| `installments` | `@OneToMany(() => Installment, i => i.plan)` | aggregate-owned |

### 5.9 Installment (`payment-plans` — table `installments`)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `paymentPlanId` | `@Column('uuid')` + `@ManyToOne(() => PaymentPlan, p => p.installments) @JoinColumn({ name: 'payment_plan_id' })` | |
| `installmentNumber` | `@Column('int')` | UNIQUE(payment_plan_id, installment_number) |
| `principalAmount` | `numeric(10,2)` transformer | |
| `interestAmount` | `numeric(10,2)` transformer, default `'0.00'` | |
| `totalAmount` | `numeric(10,2)` transformer | = principal + interest |
| `paidAmount` | `numeric(10,2)` transformer, default `'0.00'` | accumulator |
| `dueDate` | `@Column('date')` | |
| `status` | `@Column({ type: 'enum', enum: InstallmentStatus, default: InstallmentStatus.PENDING })` | |
| — | `@Index('uq_installments_plan_number', ['paymentPlanId', 'installmentNumber'], { unique: true })` | |
| — | `@Index('idx_installments_due_status', ['dueDate', 'status'])` | reminder cron |

CHECKs: `paid_amount >= 0 AND paid_amount <= total_amount` (D1), `principal_amount >= 0 AND interest_amount >= 0 AND total_amount > 0`.

### 5.10 PaymentMethod (`payment-methods` — table `payment_methods`)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `name` | `@Column('varchar', { length: 50, unique: true })` | seed: cash, bank_transfer, qr, card |
| `isEnabled` | `@Column('bool', { default: true })` | disabled → 409 on use |
| `description` | `@Column('text', { nullable: true })` | |

### 5.11 Payment (`payments` — table `payments`)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `paymentPlanId` | `@Column('uuid')` + `@ManyToOne(() => PaymentPlan) @JoinColumn({ name: 'payment_plan_id' })` | |
| `installmentId` | `@Column('uuid', { nullable: true })` + `@ManyToOne(() => Installment) @JoinColumn({ name: 'installment_id' })` | NULL ⇔ amortization (CHECK) |
| `patientUserId` | `@Column('uuid', { nullable: true })` + `@ManyToOne(() => User) @JoinColumn({ name: 'patient_user_id' })` | patient's own user on receipt upload |
| `recordedByUserId` | `@Column('uuid')` + `@ManyToOne(() => User) @JoinColumn({ name: 'recorded_by_user_id' })` | registering user (office or patient) |
| `paymentMethodId` | `@Column('uuid')` + `@ManyToOne(() => PaymentMethod) @JoinColumn({ name: 'payment_method_id' })` | |
| `amount` | `numeric(10,2)` transformer | CHECK `> 0` |
| `type` | `@Column({ type: 'enum', enum: PaymentType })` | |
| `amortizationMode` | `@Column({ type: 'enum', enum: AmortizationMode, nullable: true })` | XOR with type |
| `paidAt` | `@Column('timestamptz', { default: () => 'now()' })` | |
| `receiptUrl` | `@Column('text', { nullable: true })` | cloudinary |
| `status` | `@Column({ type: 'enum', enum: PaymentStatus, default: PaymentStatus.PENDING_CONFIRMATION })` | |

DB CHECKs (translated from ES): `amount > 0`; `type <> 'principal_amortization' OR installment_id IS NULL`; `type <> 'installment_payment' OR installment_id IS NOT NULL`; `(type = 'principal_amortization' AND amortization_mode IS NOT NULL) OR (type <> 'principal_amortization' AND amortization_mode IS NULL)`.

### 5.12 AuditLog (`audit` — table `audit_logs`)

| Field | Decorator | Notes |
|-------|-----------|-------|
| `id` | `@PrimaryGeneratedColumn('uuid')` | |
| `userId` | `@Column('uuid', { nullable: true })` + `@ManyToOne(() => User) @JoinColumn({ name: 'user_id' })` | NULL = system action (cron) |
| `action` | `@Column('text')` | vocabulary below |
| `tableName` | `@Column('text')` | |
| `recordId` | `@Column('uuid', { nullable: true })` | polymorphic, NO FK |
| `previousData` | `@Column('jsonb', { nullable: true })` | |
| `newData` | `@Column('jsonb', { nullable: true })` | |
| `createdAt` | `@Column('timestamptz', { default: () => 'now()' })` | append-only |

Indexes: `idx_audit_logs_user (user_id)`, `idx_audit_logs_created (created_at)` (per ES source schema; two separate indexes beat the exploration map's composite — time-range scans).

**AuditService contract** (called with the transaction's `EntityManager` so the entry commits/rolls back with the business change):

```ts
// src/audit/audit.service.ts
export interface AuditEntryInput {
  userId: string | null;                 // actor; null = system/cron
  action: string;                        // 'payment_plan.created' | 'payment.confirmed' | 'payment.rejected' | 'payment_plan.recalculated' | 'surgery.status_changed'
  tableName: string;                     // 'payment_plans' | 'payments' | 'surgeries'
  recordId: string | null;
  previousData?: Record<string, unknown> | null;
  newData?: Record<string, unknown> | null;
}
@Injectable()
export class AuditService {
  async log(manager: EntityManager, entry: AuditEntryInput): Promise<void>; // manager.getRepository(AuditLog).insert(...)
}
```

---

## 6. Money Arithmetic & the Financing Engine

### 6.1 Arithmetic contract

- New dependency: **`decimal.js` (^10.4.3)** — zero-dependency, ships TS types. All money operations run through `Decimal` instances constructed from strings; per-line rounding via `toDecimalPlaces(2, Decimal.ROUND_HALF_UP)`.
- Justification vs bigint-cents: the French formula needs rational exponentiation `(1+i)^-n` and `ln` (term count); bigint-cents would hand-roll rational pow with huge numerators — more code and more ways to be subtly wrong. decimal.js is the standard financial-JS choice, and its rounding mode is first-class, not reimplemented.
- Interest per line = `round_half_up(balance × i)`; principal = `installment − interest`; last line's principal = remaining balance (remainder absorbed by construction: Σ principal = P exactly, Σ total = P + Σ interest exactly).

### 6.2 Engine (pure — no DB deps)

```ts
// src/payment-plans/financing/schedule-line.ts
export interface ScheduleLine {
  installmentNumber: number;
  principalAmount: string;   // '913.27'
  interestAmount: string;    // '200.00'
  totalAmount: string;       // '1113.27'
  dueDate: Date;             // UTC midnight (no TZ/DST drift)
}

// src/payment-plans/financing/financing-engine.ts
export class FinancingEngine {
  generateFrenchAmortizationSchedule(
    principal: string, monthlyInterestRate: string, installmentCount: number, startDate: Date,
  ): ScheduleLine[];
  computeInstallment(principal: string, monthlyInterestRate: string, installmentCount: number): string; // A = P*i/(1-(1+i)^-n)
}
```

Algorithm per line k (1..n):
1. `i = 0` → `A = P/n` (upfront: n=1 → single line, zero interest).
2. `interest = HALF_UP(balance × i, 2)`; `principal = A − interest`; **on the LAST line, `principal = balance` unconditionally** (the last installment absorbs the principal remainder by construction — NOT a mere "if principal > balance" guard, which would leave a sub-cent residue on schedules where the last regular principal stays below the balance, e.g. Option A).
3. `total = principal + interest`; `balance −= principal`.
4. `dueDate(k) = addMonthsClamped(startDate, k)`: target month = start month + k (year rollover), `day = min(startDay, daysInMonth(target))` — e.g. start `2026-01-31` → k1 `2026-02-28`, k3 `2026-04-30`. Implemented on `(y, m, d)` parts with `Date.UTC` → no DST bugs.

**Pinned expected values (become unit-test expectations)**:

| Scenario | Expected |
|----------|----------|
| Reference P=10,000.00, i=2%, n=10 | A = **1,113.27** (`round(P·i/(1−(1+i)^−n), 2)`); lines 1–9 = 1,113.27: 1 = 913.27/200.00, 2 = 931.54/181.73, 3 = 950.17/163.10, 4 = 969.17/144.10, 5 = 988.55/124.72, 6 = 1008.32/104.95, 7 = 1028.49/84.78, 8 = 1049.06/64.21, 9 = 1070.04/43.23; line 10 = 1091.39/21.83, total **1,113.22** (absorbs remainder); Σ principal = **10,000.00**, Σ interest = **1,132.65**, Σ total = **11,132.65** — matches the spec scenarios exactly |
| Option A P=5,155.19, i=2%, n=8 | A = **703.73**; lines 1–7 at 703.73, line 8 = **703.76** (principal 689.96 absorbs remainder); Σ principal 5,155.19, Σ total = **5,629.87** |
| Option B P=5,155.19, keep A=1,113.27 | 4 full installments of 1,113.27 + final fractional **1,011.50** (991.67 + 19.83); Σ principal 5,155.19 |
| Upfront P=7,000.00, n=1 | one line 7,000.00 / 0.00 |
| EOM clamp from 2026-01-31 | k1 → 2026-02-28; k3 → 2026-04-30 |

> **⚠ Rounding convention (pinned, verified by exact fixed-point arithmetic)**: the algorithm above — `A = round(P·i/(1−(1+i)^−n), 2)`, per-line `interest = round(balance·i, 2)`, LAST line principal = remaining balance (absorbs the remainder by construction) — reproduces the business doc **EXACTLY** for the base plan: all ten lines and Σ total **11,132.65** (Σ interest **1,132.65**) match the doc scenarios. The only doc deviation is Option A: the doc's 703.74 is a **one-cent rounding artifact** — the algorithm-exact installment is **703.73** (lines 1–7, last line **703.76** absorbs the remainder, Σ total 5,629.87). This is a known, ACCEPTED doc artifact — NOT an unreproducible spec total. Verify asserts the algorithm-exact values 703.73/703.76; do NOT distort the last-line interest to chase a doc total (rejected: breaks interest accounting).

---

## 7. Recalculation Strategies (strategy pattern)

```ts
// src/payment-plans/strategies/installment-recalculation.strategy.ts
export interface PendingInstallment {
  id: string; installmentNumber: number; totalAmount: string; paidAmount: string; // paidAmount always '0.00'
}
export interface RecalculatedInstallment {
  id: string; principalAmount: string; interestAmount: string; totalAmount: string;
  status: InstallmentStatus;           // 'pending' (recomputed) | 'cancelled' (in place, never deleted)
}
export interface InstallmentRecalculationContext {
  outstandingBalance: string;          // post-amortization balance
  monthlyInterestRate: string;
  pendingInstallments: PendingInstallment[];  // ordered by installmentNumber
}
export interface InstallmentRecalculationStrategy {
  readonly mode: AmortizationMode;
  recalculate(ctx: InstallmentRecalculationContext): RecalculatedInstallment[];
}
```

**Pure implementations** (unit-testable without DB; persistence is the caller's job — AD6):

| Strategy | Semantics |
|----------|-----------|
| `ReduceInstallmentRecalculationStrategy` (DEFAULT) | Keep term: `A = computeInstallment(balance, i, n)` with n = pending count; walk lines (same stepping as §6.2); all rows stay `pending` with new amounts. Expected: 5,155.19 @2% n=8 → A = **703.73**; lines 1–7 at 703.73, line 8 = **703.76** (absorbs remainder); Σ principal 5,155.19, Σ total **5,629.87** (doc's 703.74 = one-cent rounding artifact, accepted) |
| `ReduceTermRecalculationStrategy` | Keep installment: `A = pendingInstallments[0].totalAmount`; walk: interest = HALF_UP(balance×i); if `balance×(1+i) <= A` → final fractional line `total = balance + interest`; surplus trailing pending rows → `status: 'cancelled'` in place. Expected: 5,155.19 @2% A=1,113.27 → 4×1,113.27 + final **1,011.50**; count 5 of 8 pending, 3 cancelled |

Edge (both): if `outstandingBalance = '0.00'` → cancel ALL pending rows (no recompute); plan evaluation then yields `completed`.

**Factory**: `RecalculationStrategyFactory` (Nest provider in `payment-plans`, exported): `getFor(mode: AmortizationMode | null | undefined): InstallmentRecalculationStrategy` — registry keyed by `amortization_mode`, falls back to `reduce_installment`.

**Call site**: inside the confirmation transaction (and the office auto-confirm path), after `outstanding_balance −= amount` — only for `type = 'principal_amortization'`. The returned rows are persisted via the transaction's `EntityManager` (UPDATE amounts/status by stable id; never DELETE).

---

## 8. Transactions

Pattern: inject `DataSource`; money-touching operations run inside `dataSource.transaction(async (manager) => { ... })` (auto ROLLBACK on throw). Row locks: `manager.findOne(PaymentPlan, { where: { id }, lock: { mode: 'pessimistic_write' } })` (`SELECT ... FOR UPDATE`).

**The plan row is the serialization point for ALL money effects** — every effect path (auto-confirm, confirm, amortization) locks the plan first, so concurrent payments on the same plan serialize.

### 8.1 Endpoints that MUST run in a transaction

| # | Endpoint | Transaction contents |
|---|----------|---------------------|
| T1 | `POST /api/payment-plans` | validate surgery/plan/catalog → plan row + installments (schedule) + down_payment payment (auto-confirmed, method validated) + audit `payment_plan.created` |
| T2 | `POST /api/payments` (office/admin) | insert payment → auto-confirm: lock plan → apply effects (shared helper) → plan evaluation → audit `payment.confirmed` |
| T3 | `POST /api/payments` (patient) | insert payment row `pending_confirmation` only (no effects, no audit) |
| T4 | `POST /api/payments/:id/confirm` | lock plan → validate state → apply effects by type → recalculation → plan evaluation → audit(s) → commit |
| T5 | `POST /api/payments/:id/reject` | lock payment row → validate pending → status `rejected` → audit `payment.rejected` (side-effect free) |
| T6 | `PATCH /api/surgeries/:id/status` | update status + audit `surgery.status_changed` |
| T7 | `POST /api/surgeries/:id/doctors/reassign-principal` | demote current principal → promote new one (in this order, one tx; partial index is per-statement so demote must precede promote) |
| T8 | `POST /api/doctors` | insert `users` (role doctor, bcrypt) + `doctors` row; license duplicate rolls back the user |
| T9 | `POST /api/patients/:id/link-user` | set `patients.user_id`; user-already-linked → 409, nothing persisted |

Single-statement CRUD (patient create/update, doctor update, catalog CRUD, surgery create/update) needs no explicit transaction — a statement is atomic.

### 8.2 Pinned `confirmPayment` flow (T4)

```
BEGIN
1.  SELECT payment FOR UPDATE; assert status = 'pending_confirmation'        (else 409 terminal)
2.  SELECT plan FOR UPDATE (pessimistic_write)
3.  Assert plan.status IN ('active','delinquent')                            (completed/cancelled → 409)
4.  Switch payment.type:
    - down_payment:            no schedule/balance effect (defensive; never pending in practice)
    - installment_payment:     SELECT installment; assert paid_amount + amount <= total_amount  (else 409, D1)
                               paid_amount += amount
                               status: 'partial' (0 < paid <= total) | 'paid' (paid == total)
                               principalDelta = creditPrincipal(paid_after) - creditPrincipal(paid_before)
                               outstanding_balance -= principalDelta
    - principal_amortization:  assert amount <= outstanding_balance          (else 409, spec scenario)
                               outstanding_balance -= amount
                               recalc = factory.getFor(amortization_mode).recalculate({...})
                               persist recalc rows (UPDATE in place / CANCEL surplus)
5.  Evaluate plan lifecycle (manager):
      completed  ⇔ outstanding_balance = '0.00' AND all non-cancelled installments paid
      delinquent ⇔ NOT completed AND EXISTS non-cancelled installment with due_date < CURRENT_DATE
                   AND status IN ('pending','partial')          (DB date = no client/server drift)
      else 'active'
6.  payment.status := 'confirmed'
7.  Audit (same manager): 'payment.confirmed' {previous: pending, new: confirmed + effects};
      if amortization: 'payment_plan.recalculated' {previous: pre-recalc balance + installments, new: post}
8.  COMMIT (auto); any failure → ROLLBACK: payment, balance, installments, audit all unchanged
```

Principal-credit formula (cumulative-delta, exact at completion, no extra column):
`creditPrincipal(paid) = round_half_up(principalAmount × paid ÷ totalAmount, 2)`; at `paid = totalAmount` → `creditPrincipal = principalAmount` exactly, so a fully-paid plan drives `outstanding_balance` to `0.00` and `completed` fires.

Registration (T2) reuses the same private `applyPaymentEffects(manager, payment, actor)` + evaluation steps inside its own transaction — one code path for auto-confirm and confirm.

---

## 9. Auth Refactor (`user-auth`)

| Area | Change |
|------|--------|
| `User` entity | `role: UserRole` enum column replaces `roles: string[]`; `lastName` removed (AD7); `profile` relation kept (AD8) |
| `interfaces/valid-roles.ts` | becomes `export { UserRole as ValidRoles }` from `common/enums` (decorators/guard keep importing `ValidRoles` — minimal churn); values: `patient, doctor, office, admin` |
| `UserRoleGuard` | `if (!validRoles || validRoles.length === 0) return true; if (validRoles.includes(user.role)) return true;` → else 403 (message without lastName) |
| `CreateUserDto` | `{ email, password, name }` — public registration; any `role` field → rejected by `forbidNonWhitelisted` (400) |
| NEW `CreateStaffUserDto` | `{ email, password, name, role }` with `@IsEnum(UserRole)` restricted to `office|admin` — used by `POST /api/auth/users` (admin only) |
| `AuthService.create` | always `role = UserRole.PATIENT`, keeps profile creation, drops lastName; bcrypt(10) unchanged |
| `AuthController` | adds `POST /auth/users` guarded `@Auth(ValidRoles.admin)` |
| `JwtStrategy` / `JwtPayload` | **unchanged** — payload exactly `{ id }`; `is_active = false` → 401 |
| `seed` | `seed-data.ts` emits `role: UserRole` (1 admin + mixed patient/doctor/office); `seed.service.ts` wipes FK-safe (TRUNCATE audit_logs, payments, payment_plans, installments, surgery_doctors, surgeries, surgery_catalog, patients, doctors, users, profiles RESTART IDENTITY CASCADE) |
| Registration flows | public register → `patient`; doctors created by office/admin via `POST /api/doctors` (user+doctor atomic); office/admin created by admin via `POST /api/auth/users` or seed; `patients.user_id` NULL-able hybrid + `link-user` (T9) — `identity_document` UNIQUE means a duplicate patient insert rolls back any user row created in the same tx |

Migration contract: `roles[1]` → `role` with mapping `'admin' → 'admin'`, `'super-user' → 'admin'` (AD9), everything else (incl. legacy `'user'`) → `'patient'`; `roles` column dropped.

---

## 10. Migration Plan

Versioned, explicit `npm run migration:run`, `gen_random_uuid()` for all new defaults. Init migration untouched.

### `1786000000001-AuthSingleRole.ts`
1. `CREATE TYPE user_role AS ENUM ('patient','doctor','office','admin')`
2. `ALTER TABLE users ADD COLUMN role user_role`
3. `UPDATE users SET role = CASE roles[1] WHEN 'admin' THEN 'admin' WHEN 'super-user' THEN 'admin' ELSE 'patient' END`
4. `ALTER TABLE users ALTER COLUMN role SET NOT NULL`
5. `ALTER TABLE users DROP COLUMN roles, DROP COLUMN "lastName"`
6. Align types with ES schema: `id` default → `gen_random_uuid()`; `email`/`password` → `varchar(255)`; `name` → `varchar(50)` (profileId kept)
7. Down: re-add `roles text[] DEFAULT '{user}'` + `"lastName" text NOT NULL DEFAULT ''` (data from `role`: `'patient'→'{user}'`, else `'{<role>}'`), drop `role`, drop type, revert defaults/types.

### `1786000000002-CoreModules.ts`
1. `CREATE TYPE` × 8: `surgery_status, surgery_doctor_role, payment_plan_type, payment_plan_status, installment_status (incl. 'cancelled'), payment_type, payment_status, amortization_mode`
2. `CREATE TABLE` × 10: `patients, doctors, surgery_catalog, surgeries, surgery_doctors, payment_plans, installments, payment_methods, payments, audit_logs` — full DDL per §5 with FKs (NO ACTION, ES-faithful), CHECKs, and: UNIQUE constraints, `uq_one_principal_per_surgery` partial unique index (`ON surgery_doctors (surgery_id) WHERE role = 'principal'`), indexes `surgeries(patient_id)`, `surgery_doctors(surgery_id)`, `surgery_doctors(doctor_id)`, `installments(payment_plan_id)`, `installments(due_date, status)`, `payments(payment_plan_id)`, `payments(installment_id)`, `payments(recorded_by_user_id)`, `audit_logs(user_id)`, `audit_logs(created_at)`
3. Seed data: `INSERT payment_methods (name, is_enabled) VALUES ('cash', true), ('bank_transfer', true), ('qr', true), ('card', true)`
4. Down: drop tables (reverse FK order) then types.

Both migrations stay reversible (`migration:revert`); the auth revert restores the legacy array model.

---

## 11. API Surface (summary)

| Endpoint | Roles | Tx |
|----------|-------|----|
| `POST /api/auth/register` | public | — |
| `POST /api/auth/login`, `GET /api/auth/check-status`, `GET /api/auth/user` | public / auth | — |
| `POST /api/auth/users` | admin | — |
| `POST /api/patients`, `PATCH /api/patients/:id`, `POST /api/patients/:id/link-user` | office, admin | T9 |
| `GET /api/patients` (paginated), `GET /api/patients/:id` | office, admin; patient = own only | — |
| `POST /api/doctors`, `PATCH /api/doctors/:id` | office, admin | T8 |
| `GET /api/doctors`, `GET /api/doctors/:id` | office, admin; doctor = own | — |
| `POST/PATCH /api/surgery-catalog`, `GET /api/surgery-catalog` (+:id) | manage: office, admin; read: any auth | — |
| `POST /api/surgeries`, `PATCH /api/surgeries/:id`, `PATCH /api/surgeries/:id/status` | office, admin | T6 |
| `POST /api/surgeries/:id/doctors`, `POST /api/surgeries/:id/doctors/reassign-principal` | office, admin | T7 |
| `POST /api/payment-plans`, `GET /api/payment-plans/:id`, `GET /api/payment-plans/:id/installments` | create: office, admin; read: office/admin any, patient own plan | T1 |
| `GET /api/payment-methods` | any auth (enabled only) | — |
| `POST /api/payments`, `POST /api/payments/:id/confirm`, `POST /api/payments/:id/reject`, `GET /api/payments` | register: auth; confirm/reject: office, admin; patient sees own | T2–T5 |

Reads for patient-role: `patients/:id` = own record only (403 otherwise); `payment-plans/:id` owned via `surgery.patient.user_id == req.user.id`; installments read derives `overdue = due_date < CURRENT_DATE AND status IN ('pending','partial')` as a response flag (never a write). Error mapping: 400 validation/integrity, 401 auth, 403 role, 404 not found, 409 conflict (uniqueness, disabled method, terminal payment state, overpayment, amortization > balance, second plan per surgery, second principal, user-already-linked, total_cost edit after plan). Shared `common/errors/database-error.handler.ts` maps PG codes (23505 → 409, 23503 → 404/400, 23514 → 400, 22P02 → 400).

---

## 12. Test Strategy (strict TDD bootstrap)

Zero unit specs exist today — this change bootstraps the harness. **Proportional**: pure math → pure unit specs; transaction flows → DB integration specs; one e2e for the full confirmation flow.

| Layer | What | Approach |
|-------|------|----------|
| Unit (fast, no DB) | `FinancingEngine`, both strategies | Colocated `*.spec.ts` (matches existing `testRegex .*\.spec\.ts$`), pure functions, pinned values from §6.2/§7 |
| Integration (DB) | Patients/Doctors/Surgeries/PaymentPlans/Payments services — transactional flows (rollback on failure, overpayment 409, auto-confirm effects, recalculation, audit rows) | `Test.createTestingModule({ imports: [AppModule] })` + `dataSource.transaction` assertions; `db_creditos_test` on port 5439 |
| E2E | `test/payment-confirmation.e2e-spec.ts`: register office → catalog → patient → surgery → plan → principal_amortization → confirm → assert balance/schedule/audit via supertest | `npm run test:e2e` (config gains `setupFiles`) |

**Bootstrap**:
- `.env.test` (committed): `DB_HOST=localhost DB_PORT=5439 DB_NAME=db_creditos_test DB_USERNAME=root DB_PASSWORD=rootpassword JWT_SECRET=test-secret` (match local docker-compose).
- `src/test-utils/load-test-env.ts` (jest `setupFiles`) — `dotenv.config({ path: '.env.test' })` + assert `DB_NAME === 'db_creditos_test'` (hard guard: tests must never hit the dev DB). Runs in the worker process BEFORE `AppModule`/`TypeOrmModule.forRoot` reads env.
- `src/test-utils/setup-test-db.ts` — `ensureTestDbReady()`: connects to the `postgres` maintenance DB, `CREATE DATABASE db_creditos_test` if missing, then runs pending migrations under `pg_advisory_lock(90123)` (idempotent, parallel-safe). Each integration spec calls it in `beforeAll` — pure-unit runs never touch the DB.
- `src/test-utils/truncate.ts` — `TRUNCATE ... RESTART IDENTITY CASCADE` (tables from `information_schema`) between tests.
- `src/test-utils/test-app.ts` — `buildTestingApp()` helper for integration specs.
- `package.json` jest config: add `"setupFiles": ["<rootDir>/test-utils/load-test-env.ts"]`; e2e `jest-e2e.json`: `"setupFiles": ["<rootDir>/../src/test-utils/load-test-env.ts"]`. DB must be up (`docker compose up -d`); integration specs fail fast with a clear message otherwise. `npm test -- --runInBand` recommended for integration runs (advisory lock already makes parallel safe).

---

## 13. Spanish Docs Deliverables (`docs/`)

Source of truth: **final entities + migrations** (generated at the END of implementation, after migrations finalize, before verify). The design pins only data source + structure:

| File | Structure |
|------|-----------|
| `docs/mapeo-es-en.md` | Per-table mapping tables: `Tabla ES → Tabla EN`, `Columna ES → Columna EN`, plus enum value mapping (`Valor ES → Valor EN`); one section per table; locked next-phase tables (`message_templates`, `whatsapp_dispatches`, `bot_conversations`, `bot_messages`) listed with their EN names |
| `docs/diccionario-de-datos.md` | One section per table; rows with exact headers `Elemento | Tipo de Dato | Requerido | Descripción`; `Requerido` = Sí/No; `Tipo de Dato` from final DDL (e.g. `NUMERIC(10,2)`, `user_role`) |

---

## 14. File Inventory & Work Units

Groups are reviewable commits (work-unit-commits: behavior + its tests/docs in the same unit; each unit leaves the repo coherent).

| Work unit | Files (Create unless noted) |
|-----------|------------------------------|
| **WU-1 Auth refactor** | `migrations/1786000000001-AuthSingleRole.ts`; MOD `auth/entities/user.entity.ts`, `auth/interfaces/valid-roles.ts`, `auth/guards/user-role.guard.ts`, `auth/auth.service.ts`, `auth/auth.controller.ts`, `auth/dto/create-user.dto.ts`, `auth/dto/index.ts`; NEW `auth/dto/create-staff-user.dto.ts`; MOD `seed/data/seed-data.ts`, `seed/seed.service.ts` |
| **WU-2 Common infra** | NEW `common/enums/` (user-role, surgery-status, surgery-doctor-role, payment-plan-type, payment-plan-status, installment-status, payment-type, payment-status, amortization-mode + `index.ts`); NEW `common/transformers/decimal.transformer.ts` + `index.ts`; NEW `common/validators/is-money.validator.ts` + `index.ts`; NEW `common/errors/database-error.handler.ts` + `index.ts`; MOD `common/common.module.ts` (export enums/errors as needed) |
| **WU-3 Financing engine** | NEW `payment-plans/financing/schedule-line.ts`, `financing-engine.ts`, `financing-engine.spec.ts`; MOD `package.json` (`decimal.js` dep) |
| **WU-4 Strategies** | NEW `payment-plans/strategies/` (interface, reduce-installment, reduce-term, factory, `index.ts`, `*.spec.ts`) |
| **WU-5 Audit** | NEW `audit/` (module, service, entity, entities/index) |
| **WU-6 Patients** | NEW `patients/` (module, controller, service, entity, entities/index, 3 DTOs + index) + integration spec |
| **WU-7 Doctors** | NEW `doctors/` (module, controller, service, entity, entities/index, 2 DTOs + index) + integration spec |
| **WU-8 Surgeries + catalog** | NEW `surgery-catalog/` (module, controller, service, entity, entities/index, 2 DTOs + index); NEW `surgeries/` (module, controller, service, 2 entities, entities/index, 5 DTOs + index) + integration specs |
| **WU-9 Payment methods + plans** | NEW `payment-methods/` (module, controller, service, entity, entities/index); NEW `payment-plans/` (module, controller, service, 2 entities, entities/index, DTO + index) + integration specs |
| **WU-10 Payments** | NEW `payments/` (module, controller, service, entity, entities/index, DTO + index) + integration specs (auto-confirm, confirm, reject, overpayment 409, rollback) |
| **WU-11 Core migration** | NEW `migrations/1786000000002-CoreModules.ts` (tables + enums + indexes + payment_methods seed) |
| **WU-12 Test bootstrap** | NEW `src/test-utils/` (load-test-env, setup-test-db, truncate, test-app), NEW `.env.test`; MOD `package.json` (jest `setupFiles`), MOD `test/jest-e2e.json` |
| **WU-13 E2E flow** | NEW `test/payment-confirmation.e2e-spec.ts` |
| **WU-14 Spanish docs** | NEW `docs/mapeo-es-en.md`, `docs/diccionario-de-datos.md` |
| Wiring | MOD `src/app.module.ts` (register modules — lands with the first module units, WU-6 onward) |

`app.module.ts` register order matters: `CommonModule`, `AuditModule`, `AuthModule` (already), `PatientsModule`, `DoctorsModule`, `SurgeryCatalogModule`, `SurgeriesModule`, `PaymentMethodsModule`, `PaymentPlansModule`, `PaymentsModule`.

---

## 15. Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary is introduced or modified by this change.

---

## 16. Open Questions / Risks

- [ ] **Rounding convention** (Section 6.2): the pinned algorithm reproduces the business doc exactly for the base plan (Σ 11,132.65). The only remaining delta is the doc's Option A 703.74 vs algorithm-exact 703.73/703.76 — a known, ACCEPTED one-cent doc artifact; verify asserts the algorithm-exact values.
- [ ] Delivery strategy: proposal forecasts ~4,000–5,000 changed lines — orchestrator must resolve `delivery_strategy` (ask-on-risk default) before apply; WU groups above are chained-PR-ready.
- [ ] `users.lastName` drop (AD7): migration `001` drops the `lastName` column, the DTO field, and the seed value per the **authoritative ES schema** (`users`: id, email, password, name, role, is_active — no lastName). This is a breaking API change beyond the proposal's literal text, **accepted as such on a dev-only DB** — surfaced for user confirmation.
- [ ] `super-user → admin` mapping (AD9) is a judgment call for any legacy dev rows.
- [ ] Enum rigidity: any future value requires `ALTER TYPE` (values locked now).

## Checklist (verify readiness)

- [ ] Both resolved decisions (D1 overpayment 409, D2 total_cost default) documented with rationale
- [ ] All 7 delta specs mapped to concrete design elements (requirements/scenarios → §3–§13)
- [ ] 9 enum types incl. `installment_status 'cancelled'`; TS enums + migration DDL pinned
- [ ] Money: decimal string transformer + decimal.js + HALF_UP + last-line absorption
- [ ] confirmPayment sequence pinned (lock → validate → effects → evaluation → audit → commit)
- [ ] Auth migration contract pinned (roles[1] mapping, super-user, lastName drop, profile kept)
- [ ] Test bootstrap (db_creditos_test, advisory-locked migrations, setupFiles) specified
- [ ] File inventory grouped into reviewable work units with tests per unit
