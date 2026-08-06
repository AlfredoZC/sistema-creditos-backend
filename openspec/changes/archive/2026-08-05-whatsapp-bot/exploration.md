# Exploration: WhatsApp bot — outbound template notifications + conversational debt bot

Scope is LOCKED by the product owner (FAST-FORWARD, do not re-open):
1. **Outbound template notifications** — office/admin send WhatsApp template messages (upcoming/overdue installment reminders, confirmations, notices) tied to patients.
2. **Conversational bot** — patients text the WhatsApp number; the bot identifies them via `phone` (primary) + `identity_document` (second verification factor) and answers debt/installment status queries.
Both use the four locked tables (`message_templates`, `whatsapp_dispatches`, `bot_conversations`, `bot_messages`) from `docs/mapeo-es-en.md`. Patients may exist without a web account (`patients.user_id` NULL — hybrid model, already implemented).

## Current State

- **Stack**: NestJS 10 (Express), TypeORM 0.3 + PostgreSQL, Laravel-style migrations (`synchronize: false`, `migrations: [0-9]*` glob, latest `1786000000002-CoreModules.ts`, next migration ~`1786000000003-*`), global `/api` prefix, `ValidationPipe(whitelist, forbidNonWhitelisted)`, Swagger at `/api`, feature modules with `module/controller/service`, `entities/`, `dto/` (class-validator + barrel `index.ts`), decimal strings (never JS float), money via `decimalTransformer`.
- **Identity data ready for the bot** (`mapeo-es-en.md`, migration 002): `patients.phone` `VARCHAR(50) NOT NULL UNIQUE` (bot primary identity), `patients.identity_document` `VARCHAR(20) NOT NULL UNIQUE` (second factor), `patients.user_id` NULL (hybrid model). The patient-management spec explicitly documents this bot usage.
- **Reminder data available**: `installments` (`due_date`, `installment_number`, `principal/interest/total/paid_amount` decimal strings, `status` enum `pending/partial/paid/overdue/cancelled`) + dedicated index `idx_installments_due_date_status (due_date, status)` whose entity comment says it exists for the **reminder cron**; `payment_plans` (`outstanding_balance`, `status active/completed/delinquent/cancelled`); ownership chain `payment_plans → surgery → patient`. Installment overdue is derived at read time (`due_date < today AND status IN (pending,partial)`); the payment-processing spec adds: *"a cron SHOULD also persist status 'overdue' for the reminder/bot phase"*.
- **Audit module** (append-only `audit_logs`, `user_id` NULL = system/cron action, polymorphic `record_id` NO FK, jsonb `previous_data`/`new_data`): `AuditService.log(manager, entry)` is invoked inside the business transaction; the current vocabulary has exactly 5 actions: `payment_plan.created`, `payment.confirmed`, `payment.rejected`, `payment_plan.recalculated`, `surgery.status_changed`. `AuditEntryInput.action/tableName` are free strings — extending the vocabulary is natural.
- **Auth**: `@Auth(...)` / `@Auth(UserRole.OFFICE, UserRole.ADMIN)` decorators (JWT strategy + `UserRoleGuard`). Roles: `patient | doctor | office | admin`.
- **Environment**: `.env.template` holds `DB_*`, `PORT`, `JWT_SECRET`, `CLOUDINARY_*`; `.env.test` is a minimal test secret set. No WhatsApp-related env exists yet.
- **HTTP client**: none in dependencies. Options: native `fetch` (Node 20 global, zero deps) or add `@nestjs/axios` + `axios`. No queue infra, no `@nestjs/schedule` installed.
- **Testing**: integration specs colocated `src/**/*.spec.ts` against real test DB `db_creditos_test` (`ensureTestDbReady` runs migrations under advisory lock; `buildTestingApp` boots full `AppModule`); unique-suffix data convention (`pid+timestamp`) because suites share the DB in parallel; `truncateAllTables` available (excludes `payment_methods` reference data); evidence command `npm run test:integration` (jest `--runInBand`, strict TDD).

## Affected Areas

- `src/whatsapp/` — NEW feature module (entities, services, controllers, DTOs, provider adapter).
- `src/database/migrations/1786000000003-WhatsAppBot.ts` — NEW migration: 4 tables + enums + indexes + FKs, mirroring the `pk_/uq_/idx_/fk_/chk_` naming and `ON DELETE NO ACTION` conventions.
- `src/common/enums/` — NEW enums (e.g. `dispatch_status`, `bot_direction`, `template_category/status`) for cross-module vocabulary, following the existing per-enum file + `index.ts` pattern.
- `src/app.module.ts` — register `WhatsappModule`.
- `src/main.ts` — enable `rawBody: true` on `NestFactory.create` (required for Meta `x-hub-signature-256` verification over the exact payload).
- `src/audit/` — no code change required; new actions use the existing `AuditService` contract.
- `src/patients/`, `src/payment-plans/` — READ-only consumers; bot debt queries need a patient-scoped lookup path (payment-plans `findInstallments` currently filters by `surgery.patient.user_id`, which is NULL for hybrid patients — requires a bot-friendly query by `patient_id`/`phone`).
- `src/test-utils/` — possibly a fake provider helper + webhook signature test double.
- `.env.template` / `.env.test` — new `WHATSAPP_*` vars (access token, phone number id, app secret, verify token, provider mock flag).
- `docs/mapeo-es-en.md` — detailed EN column mapping for the 4 tables (it currently lists names only).
- `openspec/specs/` — new or extended specs (`whatsapp-bot` domain; possibly a delta on `payment-processing` for the overdue-cron note).

## Approaches — Provider comparison (REQUIRED)

Mandate: WhatsApp delivery options usable from Node.js/NestJS, with real tradeoffs for a production credit platform in LatAm (spec evidence uses Bolivian number format `+591...`).

### 1. Meta WhatsApp Cloud API (official, direct integration) — RECOMMENDED

- **In this stack**: plain HTTPS REST to `graph.facebook.com/<version>/<phone_number_id>/messages` + webhook receiver. HTTP client: native `fetch` (zero deps) or `@nestjs/axios` wrapper. Outbound template call shape: `POST messages` with `{ messaging_product: "whatsapp", to, type: "template", template: { name, language, components: [{ type: "body", parameters: [...] }] } }`. Status callbacks arrive on the same webhook (`"statuses"` array with `wamid`, status `sent/delivered/read/failed`, `errors`).
- **Webhook security**: GET verification handshake (`hub.mode`, `hub.verify_token`, `hub.challenge`) + POST signed with `x-hub-signature-256` = `sha256=<HMAC-SHA256(app_secret, rawBody)>`. NestJS 10 supports `rawBody: true`; the signature MUST be computed over the exact raw bytes before JSON parsing. Reject mismatches with 401/403; answer 200 fast; dedupe duplicate deliveries by `wamid`.
- **Template approval workflow**: business-initiated messages REQUIRE pre-approved templates; create/submit via `POST /<waba_id>/message_templates` (name, language, category, body with `{{1}}` variables), poll/`GET` status (`APPROVED/REJECTED/PENDING/PAUSED`), deletion `DELETE`. Category (utility/marketing/authentication) is assigned/reviewed by Meta and drives price; wrong category → rejection or reclassification.
- **Costs (2026, per delivered template message; July 2025 per-message model)**: marketing ~$0.025 (US), utility ~$0.004–0.0068 and free inside an open 24h customer-service window (CSW), authentication ~$0.004–0.0068, service messages (inbound replies inside CSW) FREE, 72h free-entry-point windows free. Volume tiers for utility/authentication. LatAm rates sit in the "Rest of Latin America"/Brazil rate regions. API access itself is free.
- **Business/policy**: requires Meta business verification, WABA setup, business phone number + display name approval, app secret, customer **opt-in** before sending, messaging quality tiers (verified accounts start ~1,000 unique users/day), marketing per-user frequency cap (~2/day, error `131049`), request limits 200→5000 req/hr per active number.
- **Sandbox/test**: the Cloud API get-started flow creates a test WABA + test phone number with relaxed limits and no payment method; templates still need approval (fast-tracked in test WABA). For our stack the provider must be an interface anyway, so unit/integration tests use a mock provider — no real WhatsApp in CI.
- **Pros**: no BSP markup — utility/service messaging at the cheapest official rate; full webhook + template-lifecycle control; official, supported, stable; direct Graph API also covers template CRUD (auto-submit from our `message_templates`).
- **Cons**: onboarding is self-serve and policy-heavy (business verification, WABA, display name, opt-in, marketing frequency rules); you own retry/status handling; LatAm verification can take days; raw-body signature handling is a custom integration detail.
- **Effort**: Medium–High.

### 2. Twilio WhatsApp (BSP)

- **In this stack**: `twilio` npm SDK (or REST) + `X-Twilio-Signature` verification (HMAC-SHA1 over URL + sorted params) on the webhook; templates provisioned via Twilio Content Template Builder/Content API returning a Content SID used in outbound calls. Sandbox gives pre-approved test templates (join-code flow, no custom templates, NOT for production).
- **Costs (2026)**: Twilio fee $0.005/message (+$0.001 failed-message processing) ON TOP of pass-through Meta template fees (utility from $0.0034, free inside CSW). Strictly more expensive per message than direct Meta for the same Meta fee.
- **Business/policy**: Twilio is still on the Meta platform — you still need WABA + Meta template approval; Twilio softens onboarding (console, docs, support) but does not remove Meta policy.
- **Pros**: managed onboarding + console + support; simpler docs/SDK; sandbox for smoke tests; vendor handles some verification plumbing.
- **Cons**: per-message markup on every send; sandbox can't test custom templates or production flows; you still face Meta approval lag; extra dependency and vendor lock for a thin HTTP layer.
- **Effort**: Low–Medium.

### 3. Baileys (unofficial WhatsApp Web protocol) — REJECTED for production

- **In this stack**: WebSocket multi-device library, no managed webhooks (status polling), no template API, phone-pairing QR.
- **Pros**: "free" (no Meta per-message fee), works with a plain number.
- **Cons**: violates WhatsApp Terms of Service; number-ban risk at business scale; no delivery SLA/guarantees; no official template approval (reminders would look like spam from a personal number); zero auditability and legal exposure for a credit platform; breaks as soon as WhatsApp changes protocol.
- **Effort**: Low to start, unbounded long-term risk.

### Recommendation

**Meta WhatsApp Cloud API, integrated directly in NestJS through a `WhatsAppProvider` port/interface**, with a mock/fake implementation in tests and a config flag (`WHATSAPP_PROVIDER=mock|meta`) so CI never touches real WhatsApp. Rationale for a LatAm credit platform: cheapest official unit economics (service inbound free, utility templates cheap, no BSP markup), full control of template lifecycle + status webhooks needed for the `whatsapp_dispatches`/`bot_messages` record, and official stability for a regulated financial domain (Baileys is disqualifying). Twilio remains a drop-in alternative behind the same interface if the team prefers managed onboarding — the adapter keeps that door open. Provider onboarding (business verification, WABA, number, app secret) is a production precondition that must be tracked (CRITICAL risk), not a code blocker: the module is fully testable against mocks.

## Integration Points

- **patients.phone / identity_document**: bot lookup is `phone` first (unique), `identity_document` as second factor for verification. RISK: Meta delivers `wa_id` in E.164 (`+59170000001`), `patients.phone` is free-text `VARCHAR(50)` with no format CHECK — lookups silently miss on non-normalized numbers. Needs a normalizer (strip separators, country-code handling) + optional data-quality migration; document the canonical phone format.
- **Reminder data**: next/upcoming installment = earliest `installments.due_date >= today` with `status IN (pending, partial)` per plan; overdue amount = sum of `total_amount - paid_amount` for `due_date < today AND status IN (pending, partial)`; debt summary = `payment_plans.outstanding_balance` + plan status. All money as decimal strings. `idx_installments_due_date_status` was built for exactly this.
- **Bot debt queries**: `payment-plans` read methods gate on `surgery.patient.user_id` (JWT user) — hybrid patients have `user_id NULL`, so the bot needs a new patient-scoped query path (by `patient_id`/phone), either a dedicated service method in `payment-plans` or a read-only query in the whatsapp module. Design decision for the design phase.
- **Audit fit (5 actions)**: extend the vocabulary with new action strings per existing convention, e.g. `whatsapp_dispatch.created`, `whatsapp_dispatch.status_changed`, `bot_conversation.started`, `bot_message.received`; `user_id` = acting office/admin on manual triggers, NULL on bot/system events; `table_name` = `whatsapp_dispatches` / `bot_conversations` / `bot_messages`; in-transaction via `AuditService.log(manager, ...)`. Keep JSONB payloads free of full PII message bodies where possible (see risks).
- **Auth for trigger endpoints**: `@Auth(UserRole.OFFICE, UserRole.ADMIN)` on template CRUD, dispatch trigger, and dispatch retry endpoints (mirrors payments). The webhook controller is PUBLIC (no JWT) but protected by provider signature verification — must be excluded from any global guard (there is none today) and must not leak business data to unauthenticated callers.
- **Env**: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_WABA_ID`, `WHATSAPP_PROVIDER` (mock|meta), `WHATSAPP_WEBHOOK_PATH`. Follow `.env.template`/`.env.test` conventions.

## Architecture Sketch (to compare in design)

- **Outbound dispatch flow**: office/admin trigger (`POST /api/whatsapp/dispatches` with patientId + templateId + variable values) → resolve template + patient → (DB transaction: insert `whatsapp_dispatches` row with `status=queued`, audit `whatsapp_dispatch.created`) → call provider adapter (`sendTemplate(phone, template, params)`) → update dispatch with provider `wamid`/`status=sent`/error → provider status callback webhook updates dispatch (`delivered/read/failed`) idempotently → retry endpoint re-dispatches failed rows (DB-driven; no queue infra yet — keep a simple status machine; a dedicated queue/worker is a later evolution).
- **Conversational flow**: user texts number → Meta webhook POST → verify signature → dedupe by `wamid` → find-or-create `bot_conversations` by `wa_id` → identify via `patients.phone` (normalized) → if not identified, request `identity_document` as second factor (state field on conversation), verify match → intent mapping (simple keyword/option menu, e.g. "saldo", "cuotas", "próxima") → compose debt summary from installments/payment plans → reply via provider (free-form text inside the 24h CSW — free) → persist `bot_messages` rows (direction, body, intent, provider message id) inside one transaction with the audit entry.
- **Template management CRUD**: office/admin CRUD on `message_templates`; decision: mirror-only vs create-through Meta (recommended create-through: local row mirrors provider id/status/category; submit/poll via Graph API so office sees approval state). Sample/example variable values stored locally for preview.
- **Idempotency/retry**: `bot_messages.provider_message_id` UNIQUE (webhook dedup); dispatch status transitions constrained (queued → sent → delivered/read|failed, retry allowed only from failed/queued); webhook handler idempotent on `wamid` + status.
- **Webhook security**: GET verify token check → `hub.challenge`; POST → constant-time compare of `x-hub-signature-256` over `req.rawBody` (requires `rawBody: true` in `main.ts`); reject otherwise.
- **Audit integration**: as described above, in-transaction with the business write.

## Data Model Thinking (design phase owns final schema)

- `message_templates`: `id` uuid PK, `name`, `category` (enum: utility|marketing|authentication — utility for reminders), `language`, `body_template` (with `{{1}}` placeholders), `sample_variables` jsonb, `status` (draft|submitted|approved|rejected|paused), `provider_template_id`, `provider_status`, `is_active`, `created_at`/`updated_at`, `created_by_user_id`.
- `whatsapp_dispatches`: `id` uuid PK, `patient_id` FK→patients, `template_id` FK→message_templates, `status` enum (queued|sent|delivered|read|failed), `provider_message_id` (`wamid`), `provider_error` text, `payload` jsonb (resolved variables, non-PII), `phone` snapshot, `created_by_user_id`, `created_at`/`updated_at`/`sent_at`.
- `bot_conversations`: `id` uuid PK, `patient_id` FK NULL until identified, `wa_id` varchar unique indexed, `state` enum (unidentified|awaiting_document|identified) — free-form intent state may live in a text field, `last_activity_at`, `started_at`/`ended_at`, `created_at`.
- `bot_messages`: `id` uuid PK, `conversation_id` FK→bot_conversations, `direction` enum (inbound|outbound), `body` text, `provider_message_id` varchar UNIQUE (idempotency), `type` (text|template), `template_id` FK nullable, `intent` text nullable, `metadata` jsonb nullable, `created_at`.
- Conventions to preserve: uuid `gen_random_uuid()` PKs, `pk_/uq_/idx_/fk_/chk_` naming, `ON DELETE NO ACTION`, enums created in the migration (not TypeORM sync), indexes for the hot lookups (wa_id, phone, dispatch status, provider_message_id).

## Risks

- [CRITICAL] Provider onboarding is an external dependency: business verification, WABA, phone number, display-name approval, opt-in evidence, template approval lag (days), Meta policy/reclassification. Code can be fully built and tested on mocks, but production activation cannot be verified in CI — plan a manual provider smoke phase and env-driven config.
- [CRITICAL] Webhook security: signature verification REQUIRES the raw request body (`rawBody: true`); a parse-first implementation (e.g. reading `req.body` JSON) breaks verification and opens a spoofing vector. Verify-then-parse, constant-time compare, dedupe by `wamid`.
- [WARNING] Phone normalization mismatch: free-text `patients.phone` vs E.164 `wa_id` will silently break identification and reminders. Needs a normalizer + data-quality pass (decision: migration-clean or lookup-normalize-only).
- [WARNING] Privacy/PII: `bot_messages` and audit JSONB will contain identity documents, debt amounts, phone numbers — LatAm data-protection exposure. Avoid full PII in audit payloads; define retention (bot data) and redaction; default TLS at rest (Postgres).
- [WARNING] Message cost & policy: mislabeled templates (marketing vs utility) cost ~6x more and hit per-user frequency caps (error 131049). Reminder templates MUST be engineered as `utility`; office users need category guidance.
- [WARNING] Scope boundary: the payment-processing spec hints at an overdue-persisting cron and the installment index is built for a "reminder cron", but the locked owner scope is manual office/admin dispatch. Decide explicitly in proposal whether cron/scheduled dispatch is in or out of this change (out today — a `@nestjs/schedule` addition would otherwise be needed; no scheduler dependency exists).
- [WARNING] Testing without real WhatsApp: provider adapter must be an interface + fake; unit tests cover resolution/serialization/verification math with a known app secret; integration tests must assert the provider is NEVER called (mock injected via module override or env flag).

## Open Questions for the Proposal Phase (top 3)

1. **Provider confirmation + credentials**: is Meta Cloud API direct acceptable (recommended), or is a BSP (Twilio) wanted for managed onboarding? Who owns the WABA/business-verification/opt-in artifacts, and is there an approved test WABA for a manual smoke after implementation?
2. **Phone normalization scope**: do we migrate/normalize existing `patients.phone` values to a canonical E.164-ish shape, normalize only at lookup time, or both? (Determines whether a data migration sits in `1786000000003-*`.)
3. **Template management depth & cron boundary**: create-through-Meta auto-submit + status mirroring (recommended) vs mirror-only metadata; and is the overdue/reminder cron part of THIS change or intentionally deferred (owner scope reads manual-only)?

## Ready for Proposal

Yes — the codebase already anticipated this phase (locked table names, bot identity columns, installment reminder index, audit contract, hybrid patients). The proposal must pin down the provider choice, phone normalization, and cron boundary above, and sequence the provider onboarding work as a tracked production precondition.