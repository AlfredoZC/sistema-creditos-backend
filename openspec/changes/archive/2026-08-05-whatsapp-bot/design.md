# Design: WhatsApp Bot — Outbound Template Notifications + Conversational Debt Bot

**Change**: `whatsapp-bot` — manual outbound template dispatches (office/admin), conversational debt bot (hybrid patients, `user_id` NULL), template lifecycle with Meta submission + status mirroring, signature-verified public webhook, patient-scoped debt read, phone canonicalization data pass, and the corresponding ES→EN documentation.

**Technical approach**: a new `src/whatsapp/` feature module following the existing convention (module/controller/service + `entities/` + `dto/` barrels, `@ApiProperty`, whitelist ValidationPipe, global `/api` prefix), a `WhatsAppProvider` port (interface + Meta Cloud API adapter + runtime mock + factory driven by `WHATSAPP_PROVIDER`), zero new dependencies (Node 20 native `fetch`, `AbortSignal.timeout`, node `crypto`), explicit in-transaction `AuditService.log()` calls (existing contract, unchanged), one versioned migration (`1786000000003-WhatsAppBot.ts`) carrying 5 enum types, 4 tables + a one-time phone-backup table, a conservative report-only phone data pass, and the patient-scoped debt read added to the existing `PaymentPlansService` (service method only, never a route).

---

## 1. Resolved Business Decisions

### Decision D1: Duplicate dispatch dedupe — deterministic `dedupe_key` UNIQUE column, 409 on collision

**Choice**: `whatsapp_dispatches` gains `dedupe_key text` (nullable, UNIQUE) computed as `sha256(patient_id ‖ template_id ‖ created_by_user_id ‖ canonicalJson(variables))`. A concurrent identical insert hits 23505 → mapped to `409 Conflict` ("an identical dispatch already exists") via the shared `handleDatabaseError`. The row and send each happen exactly once.

**Alternatives considered**: *in-flight window check* (`status='queued'` per patient+template+actor after locking the patient row `FOR UPDATE`) — races: after the first send completes, a third request no longer matches `queued` and duplicates; *total dedupe on all history* — office legitimately re-sends the same reminder to the same patient later. The UNIQUE column is exact, DB-enforced, and immune to send timing.

**Rationale**: the spec requires *exactly one row and one provider call* under concurrency ("Duplicate dispatch deduplicated"). A deterministic key makes the serialization point the constraint itself, not a heuristic window. The key excludes the id itself (stable across the two racing inserts) and canonicalizes the JSON so key order cannot split the dedupe.

### Decision D2: Max-3 send attempts — `send_attempts` counter column + CHECK + service gate

**Choice**: `whatsapp_dispatches.send_attempts smallint NOT NULL DEFAULT 0` with `CHECK (send_attempts >= 0 AND send_attempts <= 3)`. The initial dispatch is attempt 1; every retry increments. A send is only allowed while `send_attempts < 3` (else `409 Conflict`, office creates a new dispatch). The increment happens in the same transaction that routes the row to `'queued'` BEFORE the provider call, so a crash after the provider call still consumes an attempt.

**Rationale**: DB-level CHECK pins the invariant (spec "Attempt limit reached"); increment-before-send means a failed send cannot be re-attempted for free. No scheduler/backoff in this change (spec decision Q3).

### Decision D3: Phone data pass is self-contained in the migration (documented duplication)

**Choice**: the conservative normalization logic lives BOTH in `src/whatsapp/phone-normalizer.ts` (runtime, shared with `patients`) AND as a deliberately duplicated private function inside the migration, cross-referenced by a comment.

**Alternatives considered**: *importing `phone-normalizer.ts` from the migration* — DRY but couples an immutable migration snapshot to application code that can evolve; a later normalizer change would silently alter historical migration semantics.

**Rationale**: migrations must stay byte-stable snapshots. The pass rewrites `patients.phone` from a one-time `phone_normalization_backup` table so `down()` can restore originals, and logs every rewritten AND every skipped row to the migration console output (spec "Phone Data-Quality Migration Convention").

### Decision D4: Next-due selection and zero summary shape for the debt read

**Choice**: `getPatientDebtSummary(patientId)` returns `{ outstandingBalance, nextDueInstallment, overdueTotal }`. `outstandingBalance` = `payment_plans.outstanding_balance` of the patient's most recent non-completed/non-cancelled plan (status `active|delinquent`, latest `start_date`; the column is the platform's tracked "capital vivo" — never recomputed, avoids double-counting interest). `nextDueInstallment` = earliest (`due_date` ASC, then `installment_number` ASC) non-cancelled installment with status `pending|partial` AND `due_date >= today`; rows already overdue belong to `overdueTotal`, not next-due. `overdueTotal` = `Σ decimal(total_amount − paid_amount)` (decimal.js, `ROUND_HALF_UP` 2) over installments with status `pending|partial` AND `due_date < today` — overdue is derived at read time (spec). For a patient with no plan (or only completed/cancelled plans): `outstandingBalance: '0.00'`, `overdueTotal: '0.00'`, `nextDueInstallment: null` (the "zero summary"; `installment_number`/`due_date` are not decimal fields, so `null` is the design-owned resolution of the scenario's "all fields return zero decimal strings").

**Rationale**: single source of truth for outstanding balance (the invariant maintained by `PaymentsService`), read-only derivations for everything time-dependent.

---

## 2. Architecture Decisions (summary)

| # | Decision | Choice | Alternatives rejected |
|---|----------|--------|----------------------|
| AD1 | Provider abstraction | `WhatsAppProvider` port with `sendTemplate` + `submitTemplate`; `MetaCloudApiProvider` adapter, `MockWhatsAppProvider`, factory keyed by `WHATSAPP_PROVIDER` (`mock\|meta`, unknown value = fail fast) | Meta API called directly from services (untestable); Twilio as a second production adapter (proposal: swappable behind the port, NOT built) |
| AD2 | HTTP client | Native global `fetch` + `AbortSignal.timeout(10000)`; meta transport errors surfaced as typed `ProviderSendError`/`ProviderTemplateError` | `@nestjs/axios` (new dep — zero-deps constraint); undici wrapper (native fetch IS undici) |
| AD3 | Webhook signature | `rawBody: true` at bootstrap; verify-then-parse; constant-time HMAC-SHA256 (`crypto.timingSafeEqual`) over raw bytes vs `x-hub-signature-256` | parse-first (spoofing vector, spec-flagged); `express.raw` middleware (duplicate body handling) |
| AD4 | Webhook path | `@Controller(process.env.WHATSAPP_WEBHOOK_PATH ?? 'whatsapp/webhook')` → `/api/whatsapp/webhook`; NO `@Auth()` (per-controller guards mean the public controller is naturally JWT-excluded) | A global guard exemption list (`APP_GUARD` — the app has none) |
| AD5 | Provider call boundary | Provider calls happen AFTER the business transaction commits (dispatch created → send → row update; bot reply row → send → row update), mirroring the spec's "provider is called after commit" | Provider inside the transaction (network I/O holds locks; a slow provider stalls the whole row) |
| AD6 | Wamid dedupe | `whatsapp_dispatches.provider_message_id` UNIQUE and `bot_messages.provider_message_id` UNIQUE; webhook processing treats 23505 and "no matching dispatch" as no-ops | A separate dedupe table (extra writes for no gain) |
| AD7 | CSW window evaluation | Window = `now − last_activity_at < 24h` evaluated at processing START, before the current inbound updates `last_activity_at` — so a message arriving after 24h of silence gets the template fallback (spec "Outside CSW template fallback") | Evaluating after the update (would always be open → scenario impossible) |
| AD8 | Audit vocabulary extension | Design-owned additions `bot_message.sent` (outbound replies) and `bot_conversation.identification_failed` beyond the proposal's list — the spec's atomicity scenario ("Every bot message MUST be persisted ... in the SAME transaction as its audit entry") requires an entry for replies, and 'received' would mislabel outbound rows | Skipping audits for outbound (violates atomicity scenario); reusing `bot_message.received` for outbound (semantically wrong) |
| AD9 | Audit PII boundary | Audit `newData` carries ONLY operational fields: uuids (`patientId`, `templateId`, `recordId`), statuses, `providerMessageId`, `failedAttempts`, direction/type/intent — NEVER `wa_id`/phone, identity documents, message bodies, template bodies, resolved variables, or debt amounts | Mirroring full rows (spec "No PII in audit payloads") |
| AD10 | Migration self-containment | Migration re-implements (duplicated) the conservative normalizer + the backup/restore mechanics inline (D3) | Importing runtime normalizer |

---

## 3. Module Topology

```
src/
├── app.module.ts                         (MOD — register WhatsappModule; order: after PaymentPlansModule)
├── main.ts                               (MOD — NestFactory.create(AppModule, { rawBody: true }))
├── common/enums/                         (MOD — 5 new enum files + index.ts + enums.spec.ts)
│   ├── dispatch-status.enum.ts           (NEW)  DispatchStatus
│   ├── bot-direction.enum.ts             (NEW)  BotDirection
│   ├── bot-conversation-state.enum.ts    (NEW)  BotConversationState
│   ├── template-category.enum.ts         (NEW)  TemplateCategory
│   └── template-status.enum.ts           (NEW)  TemplateStatus
├── payment-plans/
│   └── payment-plans.service.ts          (MOD — add getPatientDebtSummary + PatientDebtSummary interface; NO new route)
├── whatsapp/                             (NEW — feature module)
│   ├── whatsapp.module.ts
│   ├── phone-normalizer.ts + phone-normalizer.spec.ts          (pure, shared with patients)
│   ├── webhook-signature.service.ts + webhook-signature.spec.ts (constant-time HMAC + verify-token)
│   ├── intent-parser.ts + intent-parser.spec.ts                 (pure: 'saldo'|'cuotas'|'proxima'|null)
│   ├── templates.controller.ts / templates.service.ts + templates.spec.ts
│   ├── dispatches.controller.ts / dispatches.service.ts + dispatches.spec.ts
│   ├── webhook.controller.ts / webhook.service.ts + webhook.spec.ts
│   ├── bot.service.ts + bot.spec.ts
│   ├── entities/message-template.entity.ts + whatssapp-dispatch.entity.ts
│   │        / bot-conversation.entity.ts + bot-message.entity.ts + index.ts
│   ├── dto/create-template.dto.ts / update-template.dto.ts / create-dispatch.dto.ts + index.ts
│   └── provider/
│       ├── whatsapp-provider.interface.ts + whatsapp-provider.factory.ts
│       ├── meta-cloud-api.provider.ts + meta-cloud-api.provider.spec.ts (unit, mocked fetch)
│       ├── mock-whatsapp-provider.ts + mock-whatsapp-provider.spec.ts
│       └── provider-errors.ts
├── patients/
│   └── patients.service.ts               (MOD — normalize phone via normalizer on create/update) + patients.spec.ts
├── test-utils/                           (MOD)
│   ├── migration-test-db.ts              (MOD — add WHATSAPP_MIGRATION_TEST_DATABASE + migrateUpTo option)
│   └── whatsapp-webhook-client.ts        (NEW — build signed raw-body webhook POST/GET for tests)
├── database/migrations/
│   └── 1786000000003-WhatsAppBot.ts      (NEW) + whatsapp-bot.migration.spec.ts (NEW)
├── .env.template / .env.test             (MOD — WHATSAPP_* vars)
└── docs/mapeo-es-en.md, docs/diccionario-de-datos.md   (MOD — §11)
```

Shared TS enums in `src/common/enums/` (mirroring the 9 existing files) so `whatsapp` and any future consumer share vocabulary without module cycles.

---

## 4. PostgreSQL Enums (5 new native types, migration `003`)

TS enums map 1:1 by string value (same convention as §4 of core-modules design), used in entity decorators as `@Column({ type: 'enum', enum: XxxEnum })`.

| # | PG type | Values (order = enum declaration) | TS enum | Notes |
|---|---------|-----------------------------------|---------|-------|
| 1 | `dispatch_status` | `'queued','sent','delivered','read','failed'` | `DispatchStatus` | DEFAULT `'queued'`; `failed` retryable |
| 2 | `bot_direction` | `'inbound','outbound'` | `BotDirection` | |
| 3 | `bot_conversation_state` | `'unidentified','awaiting_document','identified'` | `BotConversationState` | DEFAULT `'unidentified'` |
| 4 | `template_category` | `'utility','marketing','authentication'` | `TemplateCategory` | reminders enforced 'utility' at dispatch |
| 5 | `template_status` | `'draft','submitted','approved','rejected','paused'` | `TemplateStatus` | DEFAULT `'draft'` |

Enum rigidity preserved: future values only via `ALTER TYPE ... ADD VALUE`.

---

## 5. Final Schema (migration `1786000000003-WhatsAppBot.ts`)

Conventions preserved from migration `002`: `gen_random_uuid()` PKs, `pk_/uq_/idx_/fk_/chk_` naming, `ON DELETE NO ACTION ON UPDATE NO ACTION`, enums via `CREATE TYPE`, explicit `CREATE INDEX` after tables. No CHECK on `patients.phone` (legacy formats stay representable — spec). Migration class name: `WhatsAppBot1786000000003` (matches `CoreModules1786000000002` naming).

### 5.1 `message_templates`

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| id | uuid | NO | gen_random_uuid() | PK `pk_message_templates` |
| name | varchar(100) | NO | — | Meta template name |
| category | template_category | NO | — | 'utility' required for reminders (service) |
| language | varchar(10) | NO | 'es' | Meta language code |
| body_template | text | NO | — | `{{1}}…{{N}}` contiguous (service validation) |
| sample_variables | jsonb | NO | '{}'::jsonb | Meta sample content |
| status | template_status | NO | 'draft' | |
| provider_template_id | varchar(255) | YES | — | NULL until submitted |
| provider_status | varchar(50) | YES | — | raw Meta mirror (IN_APPROVAL/APPROVED/…) |
| is_active | boolean | NO | true | deactivation blocks dispatch, never deletes |
| created_by_user_id | uuid | YES | — | FK→users |
| created_at / updated_at | timestamptz | NO | now() | |

Constraints:
- `uq_message_templates_name_language UNIQUE (name, language)` — Meta identity pair
- `fk_message_templates_created_by_user_id → users(id)` NO ACTION
- `chk_message_templates_body_non_empty CHECK (body_template <> '')`

### 5.2 `whatsapp_dispatches`

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| id | uuid | NO | gen_random_uuid() | PK |
| patient_id | uuid | NO | — | FK→patients |
| template_id | uuid | NO | — | FK→message_templates |
| status | dispatch_status | NO | 'queued' | |
| send_attempts | smallint | NO | 0 | max 3 (D2) |
| provider_message_id | varchar(255) | YES | — | wamid; UNIQUE; NULL until sent |
| provider_error | text | YES | — | failure detail, never mirrored to audit |
| payload | jsonb | NO | '{}'::jsonb | resolved variables ONLY (non-PII by policy) |
| phone | varchar(50) | NO | — | canonical snapshot at dispatch time |
| dedupe_key | text | YES | — | D1 deterministic duplicate guard |
| created_by_user_id | uuid | YES | — | manual actor; NULL = system |
| created_at / updated_at / sent_at | timestamptz | NO/NO/YES | now() | |

Constraints:
- `uq_whatsapp_dispatches_provider_message_id UNIQUE (provider_message_id)`
- `uq_whatsapp_dispatches_dedupe_key UNIQUE (dedupe_key)`
- `fk_whatsapp_dispatches_patient_id → patients(id)`, `fk_whatsapp_dispatches_template_id → message_templates(id)`, `fk_whatsapp_dispatches_created_by_user_id → users(id)` — all NO ACTION
- `chk_whatsapp_dispatches_send_attempts_range CHECK (send_attempts >= 0 AND send_attempts <= 3)`
- `chk_whatsapp_dispatches_queued_has_no_wamid CHECK (status <> 'queued' OR provider_message_id IS NULL)`

Indexes: `idx_whatsapp_dispatches_status (status)`, `idx_whatsapp_dispatches_patient_id (patient_id)`, `idx_whatsapp_dispatches_created_at (created_at)`.

### 5.3 `bot_conversations`

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| id | uuid | NO | gen_random_uuid() | PK |
| wa_id | varchar(50) | NO | — | UNIQUE — at most one conversation per number (Q7) |
| patient_id | uuid | YES | — | FK→patients; NULL until identified |
| state | bot_conversation_state | NO | 'unidentified' | |
| failed_attempts | smallint | NO | 0 | identification failures; max 3 |
| lockout_until | timestamptz | YES | — | 24h soft lockout; NULL = free |
| last_activity_at | timestamptz | NO | now() | per inbound message |
| started_at | timestamptz | NO | now() | |
| ended_at | timestamptz | YES | — | NULL until an explicit close feature exists |

Constraints:
- `uq_bot_conversations_wa_id UNIQUE (wa_id)`
- `fk_bot_conversations_patient_id → patients(id)` NO ACTION
- `chk_bot_conversations_failed_attempts_range CHECK (failed_attempts >= 0 AND failed_attempts <= 3)`
- `chk_bot_conversations_lockout_requires_failures CHECK (lockout_until IS NULL OR failed_attempts >= 3)`
- `chk_bot_conversations_state_matches_patient CHECK ((state = 'identified' AND patient_id IS NOT NULL) OR (state <> 'identified' AND patient_id IS NULL))`

Indexes: `idx_bot_conversations_patient_id (patient_id)` (reverse lookup).

### 5.4 `bot_messages`

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| id | uuid | NO | gen_random_uuid() | PK |
| conversation_id | uuid | NO | — | FK→bot_conversations |
| direction | bot_direction | NO | — | |
| body | text | NO | — | message text (inbound body / rendered reply) |
| provider_message_id | varchar(255) | YES | — | UNIQUE wamid; NULL when send failed |
| type | varchar(10) | NO | 'text' | 'text'\|'template' (CHECK; not an enum — 5-enum list is fixed) |
| template_id | uuid | YES | — | FK→message_templates, set for template sends |
| intent | varchar(20) | YES | — | 'saldo'\|'cuotas'\|'proxima' (CHECK) |
| metadata | jsonb | NO | '{}'::jsonb | operational only: e.g. `{ status: 'sent'|'failed', error }` |
| created_at | timestamptz | NO | now() | append-only |

Constraints:
- `uq_bot_messages_provider_message_id UNIQUE (provider_message_id)`
- `fk_bot_messages_conversation_id → bot_conversations(id)`, `fk_bot_messages_template_id → message_templates(id)` — NO ACTION
- `chk_bot_messages_type_valid CHECK (type IN ('text','template'))`
- `chk_bot_messages_template_requires_template_type CHECK (type <> 'template' OR template_id IS NOT NULL)`
- `chk_bot_messages_intent_valid CHECK (intent IS NULL OR intent IN ('saldo','cuotas','proxima'))`

Indexes: `idx_bot_messages_conversation_id (conversation_id)`.

### 5.5 `phone_normalization_backup` (one-time backup table, D3)

| Column | Type | Notes |
|--------|------|-------|
| id | uuid | PK `pk_phone_normalization_backup`, gen_random_uuid() |
| patient_id | uuid | UNIQUE `uq_phone_normalization_backup_patient`; FK→patients NO ACTION |
| original_phone | varchar(50) | value before the pass |
| rewritten_phone | varchar(50) | canonical value written to `patients.phone` |

Only rows actually rewritten are backed up (skipped rows are untouched, so they need no restore). `down()` restores `patients.phone = backup.original_phone` for every row, then drops the backup table.

### 5.6 The phone data-quality pass (inside `up()`, conservative + report-only)

Order in `up()`: `CREATE TYPE` × 5 → `CREATE TABLE phone_normalization_backup` → 4 business tables + constraints → indexes → data pass → console report.

Pass semantics (self-contained normalizer duplicated from `phone-normalizer.ts`):
1. Load every patient's `id, phone` ordered by id.
2. Compute `normalized` per row with the deterministic heuristic (below).
3. Group by `normalized`. **Any group with > 1 member → every member is skipped and logged** (collision — never merged or guessed; covers the spec's `+59170000001` vs `59170000001` pair, and a row colliding with an already-canonical row).
4. A single-member group whose `normalized !== original` → rewrite `patients.phone = normalized` (via `UPDATE patients SET phone = $1 WHERE id = $2`), insert the backup row, log `REWRITE <id>: <original> -> <normalized>`.
5. Skip-and-log anything not matching the heuristic (landlines `24000000`, foreign `+541123456789`, ambiguous) — never guessed.
6. Console output lists EVERY rewritten and EVERY skipped row (spec): `REWRITE`, `SKIP<collision|no_heuristic>`, plus a summary count. The migration spec additionally asserts DB state and the backup rows.

Heuristic (identical rules in `src/whatsapp/phone-normalizer.ts` and the migration copy):
- Strip `[^\d+]` (separators) from the input, preserving a single leading `+`.
- 8 digits starting with 6 or 7 → `+591` + digits.
- 11 chars `591` + 8 digits → `+` + digits.
- 12 chars starting `+591` (8 following digits) → unchanged.
- Anything else → stripped form (stable, guess-free key) — landlines/foreign/ambiguous stay as-provided.

Canonical form: `+591XXXXXXXX` (12 chars). No CHECK on `patients.phone` (legacy formats remain representable). `down()`: `UPDATE patients p SET phone = b.original_phone FROM phone_normalization_backup b WHERE p.id = b.patient_id` → drop backup table → drop 4 tables → drop types.

---

## 6. Phone Normalizer (runtime, shared)

```ts
// src/whatsapp/phone-normalizer.ts  — PURE, no deps, spec section 6 of patient-management
export function normalizePhone(input: string): string;
// '+591 7000-0001'  -> '+59170000001'
// '70000001'        -> '+59170000001'
// '59170000001'     -> '+59170000001'
// '24000000'        -> '24000000'     (landline: heuristic not applicable, never guessed)
// '+541123456789'   -> '+541123456789' (foreign: as-is, separators stripped)
export function phoneMatchesLeftNormalized(left: string, right: string): boolean;
// normalizePhone(left) === normalizePhone(right)
```

`patients.service.ts` (create + update) applies `phone` through `normalizePhone` at the service boundary (DTO stays a plain string; validation unchanged) — satisfies "Registration and update SHALL store the canonical form whenever input deterministically matches the heuristic". The WhatsApp `wa_id` lookup normalizes both sides via `phoneMatchesLeftNormalized` (spec "Legacy format matches canonical at lookup").

---

## 7. Provider Layer (zero-deps)

```ts
// src/whatsapp/provider/whatsapp-provider.interface.ts
export interface TemplateVariable { name: string; value: string; }          // { name: '1', value: '...' }
export interface SendTemplateMessageInput {
  to: string;                       // normalized phone (canonical E.164-ish)
  templateName: string; language: string; variables: TemplateVariable[];
}
export interface SendTemplateMessageResult { providerMessageId: string; }   // wamid
export interface SubmitTemplateInput {
  name: string; category: TemplateCategory; language: string;
  bodyTemplate: string; sampleVariables: Record<string, string>;
}
export interface SubmitTemplateResult { providerTemplateId: string; providerStatus: string; }

export interface WhatsAppProvider {
  readonly name: 'mock' | 'meta';
  sendTemplate(input: SendTemplateMessageInput): Promise<SendTemplateMessageResult>;
  submitTemplate(input: SubmitTemplateInput): Promise<SubmitTemplateResult>;
}
```

- **`mock-whatsapp-provider.ts`** — name `'mock'`; records every call into an in-memory FIFO (`sent: SentRecord[]`, `submitted: SubmittedRecord[]`) exposed for test assertions; returns deterministic fake wamids (`wamid.mock.<n>`); can be configured to fail (`failNext: true`) for retry/failure tests. This is the runtime mock for `WHATSAPP_PROVIDER=mock` AND the integration fake — the same object, no test-only path in production code.
- **`meta-cloud-api.provider.ts`** — native `fetch`:
  - send: `POST https://graph.facebook.com/v21.0/{WHATSAPP_PHONE_NUMBER_ID}/messages`, Bearer `WHATSAPP_TOKEN`, body `{ messaging_product:'whatsapp', to, type:'template', template:{ name, language:{ code }, components:[{ type:'body', parameters: variables.map(v => ({ type:'text', text: v.value })) }] } }`, timeout `AbortSignal.timeout(10000)`. Non-2xx or Meta `error` body → `ProviderSendError('meta_http_<status>', truncatedMessage)`.
  - submit: `POST https://graph.facebook.com/v21.0/{WHATSAPP_WABA_ID}/message_templates` with `{ name, language, category, components:[{ type:'BODY', text: bodyTemplate, example:{ body_text:[[...]] } }] }` → maps `error.error.code` (e.g. 131049 marketing-mislabel) into `ProviderTemplateError`.
- **`whatsapp-provider.factory.ts`** — Nest provider: `createProvider(configService): WhatsAppProvider` switch on `WHATSAPP_PROVIDER`; `'mock'` → `MockWhatsAppProvider`; `'meta'` → `MetaCloudApiProvider` (validates required env, throw at factory call otherwise); anything else → throw on first injection (fail-fast config error).

**Isolation guarantee** (spec "Mock provider isolation"): with `WHATSAPP_PROVIDER=mock` the Meta adapter is never even constructed (factory returns only the selected implementation) — so no `fetch` can fire from `whatsapp` code in tests; integration specs assert `provider.name === 'mock'` and inspect recorded calls.

---

## 8. Webhook Signature Service

```ts
// src/whatsapp/webhook-signature.service.ts
export class WebhookSignatureService {
  constructor(config: ConfigService) {}
  verifyBodySignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean;
  verifyVerifyToken(token: string | undefined): boolean;   // constant-time vs WHATSAPP_VERIFY_TOKEN
}
```

- `verifyBodySignature`: expected = `'sha256=' + hex(hmac_sha256(appSecret, rawBody))` using `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')`; parse the header prefix and hex (length must match, else `false`); compare with `crypto.timingSafeEqual` over the raw hex buffers (missing header → `false`).
- `verifyVerifyToken`: `timingSafeEqual` over utf8 buffers after length pre-check.
- Unit spec uses a **pinned hardcoded vector**: a known app secret (e.g. `test-app-secret`) + fixed raw body → expected `x-hub-signature-256` computed once with a node one-liner and committed as a literal in the spec, PLUS a self-computed vector (same crypto call) to catch accidental regressions — the fixed literal pins the algorithm, the self-computed one keeps it honest.

---

## 9. Services + Controllers

### 9.1 `templates.controller.ts` / `templates.service.ts` (`@Controller('whatsapp/templates')`, `@Auth(UserRole.OFFICE, UserRole.ADMIN)`)

| Endpoint | Behavior |
|----------|----------|
| `POST /api/whatsapp/templates` | validate placeholders contiguous `{{1}}…{{N}}` + sample_variables keys 1:1 (400 otherwise) → insert row `draft` + audit `whatsapp_template.created` → AFTER commit `provider.submitTemplate` → update `provider_template_id`, `status='submitted'` + audit `whatsapp_template.status_changed`; submit failure → template stays `draft` with `provider_status`/error, 502 mapped to 400 with clear message |
| `GET /api/whatsapp/templates` / `GET :id` | list (filter by status/is_active, paginated like `PaginationDto`) / detail |
| `PATCH /api/whatsapp/templates/:id` | update body/samples → re-submit through Meta → back to `submitted`; audit `whatsapp_template.updated` (+ status_changed when status changes) |
| `PATCH /api/whatsapp/templates/:id/deactivate` | `is_active=false` — blocks new dispatches (dispatch gate), never deletes the row; audit `whatsapp_template.updated` |

Dispatch gate (service-shared): template dispatchable ⇔ `status='approved' AND is_active=true`; otherwise `409 Conflict` (spec "Rejected, paused, or deactivated blocked"). Reminder templates: `category='utility'` enforced at dispatch time (`409` if an office user tries a non-utility template on the reminder flow — the spec restricts reminder templates to utility; templates table itself does not force it, category is a meta-side cost control). Status mirroring: webhook `message_template_status_update` → `templates.service.mirrorProviderStatus(providerTemplateId, providerStatus)` → map to `draft|submitted|approved|rejected|paused` + audit `whatsapp_template.status_changed`.

### 9.2 `dispatches.controller.ts` / `dispatches.service.ts` (`@Controller('whatsapp/dispatches')`, `@Auth(OFFICE, ADMIN)`)

| Endpoint | Behavior |
|----------|----------|
| `POST /api/whatsapp/dispatches` | DTO `{ patientId, templateId, variables }`; validate template dispatchable (409), variables 1:1 vs placeholders incl. empty values (400, spec "Placeholder mismatch rejected") → TX: compute `dedupe_key` (D1), insert row status `'queued'` + phone snapshot = patient.phone (normalized) + payload = resolved variables only + audit `whatsapp_dispatch.created` → COMMIT → provider.sendTemplate → row `sent` + wamid + `sent_at` + `send_attempts=1` + audit `whatsapp_dispatch.status_changed` (queued→sent); failure → `failed` + truncated `provider_error` + same audit with failed transition |
| `POST /api/whatsapp/dispatches/:id/retry` | manual only; accepted ONLY from `queued\|failed` (else 409, spec "Terminal status cannot be retried"); gate `send_attempts < 3` (else 409, spec "Attempt limit reached"); TX: status→`queued`, `send_attempts += 1`, audit status_changed → COMMIT → send → `sent\|failed` + audit |
| `GET /api/whatsapp/dispatches` / `GET :id` | status tracking list (PaginationDto + optional status filter) / detail |

**Dispatch state machine**: `queued → sent → delivered → read` (monotonic success); `sent → failed` (retryable); `failed → queued → sent` (retry re-route); `delivered|read` terminal (never retried). Duplicate identical requests → `dedupe_key` 23505 → 409 via `handleDatabaseError` (D1).

### 9.3 `webhook.controller.ts` / `webhook.service.ts` (public — NO `@Auth()`)

`GET {WHATSAPP_WEBHOOK_PATH}` (handshake): `hub.mode=subscribe` + valid `hub.verify_token` (constant-time) → 200 with `hub.challenge` as plain text; missing params → 400; mismatch/missing verify_token → 403 (spec "Handshake and Signature").

`POST {WHATSAPP_WEBHOOK_PATH}`: read `req.rawBody` (Buffer); `verifyBodySignature` FIRST — missing/mismatched header → 401/403 with NO parsing, persistence, or business data (spec "Tampered POST rejected unprocessed"); valid → JSON-parse → dispatch by payload shape:

1. **`statuses[]`** (message status updates) — per entry by `wamid`: find dispatch by `provider_message_id`; none → 200 no-op (log). Effective transition only (no regression — spec "Out-of-order status does not regress"): allowed edges `sent→delivered`, `sent→failed`, `delivered→read`; anything else (incl. duplicate `delivered`) → 200 no-op, no audit. TX: `UPDATE` + audit `whatsapp_dispatch.status_changed` only on effective transition.
2. **`messages[]`** (inbound) — hand to `bot.service.processInbound` (§10); dedupe occurs at the `bot_messages.provider_message_id` UNIQUE (23505 → 200 no-op).
3. **`message_template_status_update[]`** — `templates.service.mirrorProviderStatus` (§9.1).

All paths answer 200 **fast**; `200` is sent even for duplicate/no-op webhook events (idempotency contract).

### 9.4 `bot.service.ts` — `processInbound(waId, messageId, body, timestamp)` (called from webhook.service)

Flow (see §10 sequence):

1. **Dedupe**: `bot_messages.provider_message_id = messageId` exists → return silent (200 no-op).
2. **Find-or-create conversation** by normalized `wa_id` (`phoneMatchesLeftNormalized(waId, conv.wa_id)` → exact indexed lookup `wa_id = normalizePhone(waId)`; the unique constraint guarantees at most one). Create → TX { insert conversation `unidentified` + audit `bot_conversation.started` (newData `{ state }` — no wa_id, PII) }.
3. **State machine** (TX per step below):
   - `unidentified`: find candidate patients by normalized phone (exact indexed `phone = canonical` + separator-insensitive fallback via `regexp_replace(phone, '[^0-9+]', '', 'g') = canonical` — patients table is small, fallback is a full scan, acceptable) — **exactly 1** → TX { conversation `identified`, `patient_id` set, audit `bot_conversation.identified` (newData `{ patientId, state }`), persist inbound bot_message + audit `bot_message.received` (newData `{ direction:'inbound', type:'text' }`), update `last_activity_at` } → continue to menu (§10 step 6). **0 or >1** → TX { conversation `awaiting_document`, inbound message + audit, `last_activity_at` } → reply asking for `identity_document`.
   - `awaiting_document`: if `lockout_until` set and `now < lockout_until` → ignore + re-send guidance reply (no attempt increment — spec "Soft lock after three failures"). Else verify body against the phone-candidate patients: `trim().toUpperCase() === identity_document.toUpperCase()` on a candidate whose normalized phone matches the caller's wa_id → success TX { `identified`, `patient_id`, reset `failed_attempts=0`, `lockout_until=NULL`, audit `bot_conversation.identified`, inbound message + audit } → menu. Any other outcome = failed attempt → TX { `failed_attempts += 1`, inbound message + audit; if `failed_attempts >= 3` → `lockout_until = now + 24h`, audit `bot_conversation.identification_failed` (newData `{ failedAttempts: 3 }` — no document value) , reply = clinic-contact guidance; else reply = re-request document }.
   - `identified`: parse intent (`intent-parser.ts`: lowercase + strip diacritics; keywords `saldo`, `cuota(s)`, `proxima|proximo|next`; else null) → any reply and the inbound message persist in the SAME transaction (§10 step 6).
4. **Window**: `windowOpen = now − conversation.last_activity_at < 24h` captured at processing START (before the inbound updates it — AD7).
5. **Reply generation** (after the inbound TX commits):
   - in-window: free-form text (menu or intent answer). `saldo` → `outstanding_balance`, next-due amount/date, overdue total as decimal strings (e.g. `"8155.19"`); `cuotas` → next-due installment detail; `proxima` → next-due date. Unknown intent → menu.
   - out-of-window: NO free-form — resolve an approved+active `utility` template; render the same summary through `{{1}}…{{N}}` variables; send via provider (AD5). If no such template exists OR the send fails → nothing is sent, failure recorded in `bot_messages.metadata` (spec "Outside CSW template fallback").
6. **Reply persistence TX** { insert outbound bot_message (`direction:'outbound'`, `type:'text'|'template'`, `template_id` when template, `intent` on replies, `metadata:{ status:'pending' }`) + audit `bot_message.sent` } → COMMIT → provider.sendTemplate → TX { set `provider_message_id` + `metadata.status='sent'` } OR TX { `metadata.status='failed'`, error } — the row and its audit always exist, mirroring the dispatch pattern (AD5).

**Retention/PII**: `bot_messages.body` stores user- and bot-authored text (necessary for conversation continuity); the PII boundary applies to AUDIT payloads and dispatch `payload`, NOT the message table (spec only constrains audit JSONB). No message bodies, identity documents, phone numbers, or debt amounts ever enter `audit_logs` (AD9).

---

## 10. Patient-Scoped Debt Read (payment-plans, service-only)

```ts
// src/payment-plans/payment-plans.service.ts  (MOD — mirrors existing read-method style §"findInstallments")
export interface PatientDebtSummary {
  outstandingBalance: string;
  nextDueInstallment: { installmentNumber: number; totalAmount: string; dueDate: string } | null;
  overdueTotal: string;
}
async getPatientDebtSummary(patientId: string): Promise<PatientDebtSummary>;
```

Query: latest plan for the patient — `JOIN surgeries ON surgeries.patient_id = $1` with `payment_plans.status IN ('active','delinquent')`, ordered `start_date DESC` (only non-completed/non-cancelled plans carry debt); no such plan → zero summary (D4). Derivations mirrored at read time; money via decimal.js `ROUND_HALF_UP` 2, results are decimal strings (spec "Hybrid patient summary" pins `"8155.19"` / `"1113.27"` / `"613.27"` — the test fixture builds them through the existing `FinancingEngine` + a partial payment so the values match the spec exactly). **Not exposed as a route of any kind** — consumed only by `WhatsappModule` (which imports `PaymentPlansModule`, which already exports `PaymentPlansService` — no cycle, no controller change). Patient-role web users get no surface (spec "Not exposed to patient-role users": the read is unreachable over HTTP; existing user-gated reads untouched).

---

## 11. Sequence Diagrams (rules.design)

**Dispatch create + send:**

```
Office ──POST /api/whatsapp/dispatches──► DispatchesController
    │ validate template gate (409) / variables 1:1 (400)
    └─► dataSource.transaction
           ├─ INSERT whatsapp_dispatches (queued, dedupe_key, phone snapshot)
           └─ audit whatsapp_dispatch.created
        COMMIT ──► provider.sendTemplate (AFTER commit, AD5)
              ├─ ok:  UPDATE row → sent + wamid + send_attempts=1 + audit status_changed
              └─ err: UPDATE row → failed + provider_error + audit status_changed
    ◄── 201 { id, status }
```

**Webhook status (idempotent):**

```
Meta ──POST /api/whatsapp/webhook (raw body)──► WebhookController
    ├─ getHub handshake: verify_token ⇔ challenge (400/403/200)
    └─ verifyBodySignature(rawBody, x-hub-signature-256) ─401/403, nothing parsed
        └─ parse ─► statuses[]: find dispatch by provider_message_id
             ├─ none → 200 no-op
             └─ allowed edge (sent→delivered|failed, delivered→read)?
                  ├─ yes → TX { UPDATE status, audit status_changed } → 200
                  └─ no (duplicate/regression) → 200 no-op, no audit
```

**Bot inbound (identified path):**

```
Meta ──POST webhook──► WebhookService ──► BotService.processInbound(waId, msgId, body)
    ├─ bot_messages.provider_message_id exists? ──yes──► 200 no-op (dedupe)
    └─ find-or-create conversation (uq wa_id)
        ├─ new → TX { conversation unidentified, audit bot_conversation.started }
        │        └─ audit bot_message.received (inbound)
        ├─ identify: candidates = patients by normalized phone
        │    1 → TX { identified, patient_id, audit bot_conversation.identified }
        │    0|>1 → TX { awaiting_document } → reply: request identity_document
        │    (lockout / document verification per §9.4)
        └─ identified → intent = parseIntent(body)
            windowOpen = now − last_activity_at < 24h   (pre-update, AD7)
            TX { bot_message(inbound) + audit bot_message.received, update last_activity_at, state }
    COMMIT ──► reply:
        ├─ in-window?  → free-form menu/answer text
        └─ out-window? → utility template (approved+active) or SILENT+failure metadata
        TX { bot_message(outbound) + audit bot_message.sent } → COMMIT
        └─ provider.sendTemplate → TX { wamid + metadata.status='sent' } | TX { failed }
```

---

## 12. API Surface (summary)

| Endpoint | Roles | Tx |
|----------|-------|----|
| `POST /api/whatsapp/templates`, `GET /api/whatsapp/templates` (+`:id`), `PATCH /api/whatsapp/templates/:id`, `PATCH /api/whatsapp/templates/:id/deactivate` | office, admin | row+audit; provider call after commit |
| `POST /api/whatsapp/dispatches` | office, admin | T1 (row `queued` + audit) then send |
| `POST /api/whatsapp/dispatches/:id/retry` | office, admin | T2 (re-route `queued`, attempt++ ) then send |
| `GET /api/whatsapp/dispatches` (+`:id`) | office, admin | — |
| `GET {WHATSAPP_WEBHOOK_PATH}` | public (handshake) | — |
| `POST {WHATSAPP_WEBHOOK_PATH}` | public (signature-gated) | per-event tx |
| (service-only) `PaymentPlansService.getPatientDebtSummary` | bot service | read |

Error mapping (existing helpers): 400 validation/placeholder mismatch/check violation (23514), 401 unauthorized, 403 role/signature, 404 not found (23503), 409 conflict (dedupe 23505, template not dispatchable, terminal status retry, attempt limit).

---

## 13. Testing Strategy (strict TDD — evidence `npm run test:integration`)

| Layer | What | Approach |
|-------|------|----------|
| Unit (fast, no DB) | `phone-normalizer` (spec scenarios §6: `70000001`/`59170000001`→`+59170000001`, landline/foreign as-is, `+591 7000-0001` ⇔ `59170000001`), `intent-parser` (saldo/cuotas/próxima + diacritics + null), `webhook-signature` (pinned vector + mismatch + missing header + verify_token), `MetaCloudApiProvider` (mocked global `fetch` — success, HTTP error, Meta error code, timeout/AbortSignal) | Colocated `*.spec.ts` (existing `.*\.spec\.ts$` regex), pure functions, no DB |
| Integration (DB) | Templates CRUD + dispatch gate 409 + placeholder 400, dispatch happy path / dedupe (concurrent identical POSTs → one row one send) / retry / attempt-limit, webhook handshake + tampered 401/403 + status idempotency + out-of-order no-regress, bot identification (single match, no match, correct document, soft lock after 3), debt read (hybrid patient: values `8155.19`/`1113.27`/`2026-08-05`/`613.27`; zero summary), message+audit atomicity (rollback → neither), actor vs system attribution, mock isolation (`provider.name==='mock'`, recorded calls; Meta adapter never constructed — assertion that a `fetch` spy is never called) | `Test.createTestingModule({ imports:[AppModule] })` via `buildTestingApp()` (MOD — add `rawBody:true` mirroring main.ts), `db_creditos_test`, `ensureTestDbReady()` in `beforeAll`, `truncateAllTables` between tests; `.env.test` gains `WHATSAPP_PROVIDER=mock` + test secret/token/paths; webhook requests built with new `test-utils/whatsapp-webhook-client.ts` (computes the correct `x-hub-signature-256` for the test app secret) |
| Migration spec | fresh-database path + up/down cycles on a DEDICATED throwaway DB (extends `migration-test-db.ts`: `WHATSAPP_MIGRATION_TEST_DATABASE = 'db_creditos_whatsapp_migration_test'` + an `upToVersion` filter so the phone pass can be tested by migrating to 002, inserting legacy-phoned patients, then applying 003): 4 tables + columns, 5 enum values in order, indexes, CHECKs (send_attempts >3 → 23514, state/patient_id invariant, type/template, intent CHECK), UNIQUEs (dedupe_key 23505, provider_message_id, wa_id), data pass (safe rewrite + backup row, collision skip both + console output, down() restores originals + backup table dropped) | Colocated `whatsapp-bot.migration.spec.ts`, same pattern as `core-modules.migration.spec.ts`, `jest.setTimeout(120000)` |

No e2e spec added in this change (the webhook e2e surface is covered by integration specs; existing e2e config untouched).

---

## 14. Spanish Docs Deliverables (`docs/`, generated from the FINAL migration before verify)

| File | Additions |
|------|-----------|
| `docs/mapeo-es-en.md` | The 4 "Pendiente" rows become "Implementada (migración 003)"; new per-table sections `plantilla_mensaje → message_templates`, `envio_whatsapp → whatsapp_dispatches`, `conversacion_bot → bot_conversations`, `mensaje_bot → bot_messages` with `Columna ES → Columna EN` tables (detailed EN column mapping incl. `dedupe_key`, `send_attempts`, `lockout_until`, `failed_attempts`, `provider_message_id`, `payload`, `metadata`) and enum value mapping; a new **Canonical Phone Format** section: `+591XXXXXXXX`, the deterministic heuristic, and the "as-provided" exceptions (landline/foreign/ambiguous) |
| `docs/diccionario-de-datos.md` | New section per table with the exact header convention `Elemento | Tipo de Dato | Requerido | Descripción` (`Requerido` = Sí/No) using final DDL types (`dispatch_status`, `bot_conversation_state`, `message_templates` FK notes, `{\{1\}}` placeholder convention, `send_attempts` 0–3, lockout semantics); migration row added to the "Migraciones que definen el esquema" table |

---

## 15. File Inventory & Work Units

Groups are reviewable commit units (work-unit-commits: behavior + its tests/docs in the same unit; each unit leaves the repo coherent). Line estimates are for `sdd-tasks` forecasting — several WUs exceed one 400-line review slice and MUST be split across chained PRs (proposal `Chained PRs recommended: Yes`, `400-line budget risk: High`).

| Work unit | Files (Create unless noted) | Est. lines | PR split hint |
|-----------|------------------------------|-----------|---------------|
| **WU-1 Enums + phone normalizer** | NEW `common/enums/dispatch-status.enum.ts`, `bot-direction.enum.ts`, `bot-conversation-state.enum.ts`, `template-category.enum.ts`, `template-status.enum.ts`; MOD `common/enums/index.ts`, `common/enums/enums.spec.ts`; NEW `whatsapp/phone-normalizer.ts` + `phone-normalizer.spec.ts`; MOD `patients/patients.service.ts` (normalize on create/update) + `patients/patients.spec.ts` | ~330 | 1 PR |
| **WU-2 Migration 003 + contract spec** | NEW `database/migrations/1786000000003-WhatsAppBot.ts` (enums + backup + 4 tables + indexes + phone pass + down-restore); MOD `test-utils/migration-test-db.ts` (new DB constant + `upToVersion`); NEW `database/migrations/whatsapp-bot.migration.spec.ts` | ~750 | 2 PRs: (a) migration file, (b) spec + test-utils helper |
| **WU-3 Provider layer** | NEW `whatsapp/provider/whatsapp-provider.interface.ts`, `provider-errors.ts`, `mock-whatsapp-provider.ts` + spec, `meta-cloud-api.provider.ts` + spec, `whatsapp-provider.factory.ts` + spec | ~420 | 1–2 PRs (adapter + mock/factory) |
| **WU-4 Template CRUD + module wiring** | NEW `whatsapp/whatsapp.module.ts`, `templates.controller.ts`, `templates.service.ts` + `templates.spec.ts`, `entities/message-template.entity.ts` + `entities/index.ts`, `dto/create-template.dto.ts`, `dto/update-template.dto.ts` + `dto/index.ts`; MOD `app.module.ts` (register WhatsappModule — lands with the first feature unit, mirroring core-modules convention) | ~500 | 2 PRs (entity+service+spec, controller+dto) |
| **WU-5 Dispatch flow + retry** | NEW `whatsapp/dispatches.controller.ts`, `dispatches.service.ts` + `dispatches.spec.ts`, `entities/whatsapp-dispatch.entity.ts`, `dto/create-dispatch.dto.ts` | ~480 | 2 PRs (service+entity+tx, controller + integration scenarios) |
| **WU-6 Webhook + signature** | NEW `whatsapp/webhook.controller.ts`, `webhook.service.ts` + `webhook.spec.ts`, `webhook-signature.service.ts` + spec; MOD `main.ts` (`rawBody: true`), `test-utils/test-app.ts` (`rawBody: true`); NEW `test-utils/whatsapp-webhook-client.ts` | ~520 | 2 PRs (signature+unit, controller+service+integration) |
| **WU-7 Bot conversation + debt read** | NEW `whatsapp/bot.service.ts` + `bot.spec.ts`, `intent-parser.ts` + spec, `entities/bot-conversation.entity.ts`, `entities/bot-message.entity.ts`; MOD `payment-plans/payment-plans.service.ts` (`getPatientDebtSummary` + `PatientDebtSummary`) + `payment-plans/payment-plans.spec.ts` | ~600 | 2 PRs (debt read first — bot consumes it; then bot flow) |
| **WU-8 Env + docs** | MOD `.env.template`, `.env.test` (`WHATSAPP_*`); MOD `docs/mapeo-es-en.md`, `docs/diccionario-de-datos.md` | ~200 | 1 PR |

`app.module.ts` import order: … `PaymentPlansModule`, `WhatsappModule` (after its dependency).

---

## 16. Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary is introduced or modified by this change (the webhook is HTTP-in within the same NestJS process; the provider's outbound REST calls come from application code, not shell/executables).

---

## 17. Open Questions / Risks

- [ ] **Audit vocabulary extension (AD8)**: `bot_message.sent` and `bot_conversation.identification_failed` go beyond the proposal's listed action strings. The spec's message+audit atomicity scenario REQUIRES an audit entry for every bot message including outbound replies, which forces `bot_message.sent`; `identification_failed` is optional security traceability. Flagged for orchestrator awareness; verify must not treat these as spec leakage (they serve spec scenarios).
- [ ] **D1 `dedupe_key`**: a new column beyond the proposal's data-model table — required to make "Duplicate dispatch deduplicated" deterministic under concurrency; `mapeo-es-en.md` documents it as `dedupe_key` (EN-only, no ES origin: marked "nueva columna técnica").
- [ ] **Window semantics (AD7)**: the scenario "Outside CSW template fallback" is only satisfiable if the window is evaluated pre-inbound-update — pinned in the design; the integration spec builds a conversation with `last_activity_at` > 24h old to prove template fallback.
- [ ] **Zero-summary shape (D4)**: `nextDueInstallment: null` for no-plan is the design-owned reading of "all fields return zero decimal strings" (installment_number/due_date are not decimal strings); verify confirms.
- [ ] **Delivery strategy**: proposal forecasts >1000 authored lines, `Chained PRs recommended: Yes`, `Decision needed before apply: Yes` — orchestrator must resolve `delivery_strategy` (ask-on-risk default) before sdd-tasks/apply; WU table above is chained-PR-ready.
- [ ] **CSW/template variables**: reminder templates must carry non-PII variables only (payload is stored + mirrored to Meta samples); the UI guidance is UX-side, the design only enforces the 1:1 mapping and the non-PII audit boundary.
- [ ] **Enum rigidity**: 5 new types, values locked now.

## Checklist (verify readiness)

- [ ] Final schema owned at DDL granularity: 4 tables + backup table, 5 enums, UNIQUEs (wa_id, provider_message_id ×2, dedupe_key, name+language), FKs NO ACTION, hot indexes, CHECKs incl. send_attempts ≤ 3 and state⇔patient invariant
- [ ] Retry/lockout storage mechanics: `send_attempts` max 3, `failed_attempts`/`lockout_until` 24h soft lockout, phone backup pass + down() restore
- [ ] Module architecture mapped: whatsapp/ layout, 3 controllers + bot service, provider port/mock/meta/factory, normalizer (shared), signature service, main.ts `rawBody`, env vars
- [ ] Patient-scoped debt read designed (service-only, decimal strings, zero summary, consumed by bot)
- [ ] Flows pinned: dispatch state machine + dedupe, webhook dedupe/regression, bot identification + lockout + CSW fallback, transaction boundaries + audit action strings
- [ ] Testing strategy: colocated specs, mock provider with never-constructs-Meta assertion, signature vector, migration spec with upToVersion helper
- [ ] WU breakdown with file-level granularity and PR split hints (8 WUs)
- [ ] Docs deliverables specified for the 4 tables + canonical phone format