# Proposal: WhatsApp Bot — Outbound Template Notifications + Conversational Debt Bot

## Intent

Office/admin send payment reminders/confirmations via WhatsApp templates; patients (incl. hybrid, no web account) self-serve debt status 24/7 by texting the clinic number. Unlocks the identity data (`patients.phone`/`identity_document`) and reminder index already built for this phase; cuts collection friction and office support load.

## Scope

### In Scope (owner-locked)
- **Manual outbound dispatch** (office/admin trigger only: patient + template + variables → provider send → status tracking).
- **Conversational bot**: identify via `phone` + `identity_document` (second factor), answer debt/installment queries, persist conversation/messages.
- **Template CRUD** with create-through-Meta submission + approval-state mirroring.
- **Provider abstraction**: `WhatsAppProvider` port; Meta adapter; mock for tests; `WHATSAPP_PROVIDER=mock|meta`. Twilio swappable behind the same interface (design note, NOT a second provider).
- **Webhook**: GET verify handshake + POST statuses/inbound, signature-verified, idempotent.
- **Audit**: new action strings via existing `AuditService` (no audit-module change): `whatsapp_dispatch.created/status_changed`, `whatsapp_template.*`, `bot_conversation.started/identified`, `bot_message.received`; `user_id` = actor on manual, NULL on bot/system.
- **Migration `1786000000003-WhatsAppBot.ts`**: 4 tables + enums + indexes + FKs + conservative phone data pass (below).
- **NEW patient-scoped debt read** (payment-plans reads gate on `surgery.patient.user_id`, NULL for hybrid).
- **Docs**: `mapeo-es-en.md` detailed column mapping (4 tables) + canonical phone format; `diccionario-de-datos.md`.

### Out of Scope / Non-Goals
- **Overdue/reminder CRON and any scheduled dispatch** — the payment-processing spec's cron SHOULD stays unfulfilled by this change; no `@nestjs/schedule`.
- Marketing campaigns/broadcast, multi-language template UI, queue/worker infra, agent handoff, multi-number routing.
- Real provider onboarding steps (external precondition — tracked, not built).

## Phone Normalization (decision)

Canonical form: E.164-ish `+591XXXXXXXX` (mobile; spec evidence `+59170000001`). **Both**: lookup-time normalizer (pure function; wa_id and stored phone normalized before compare) AND a data-quality pass **riding in `1786000000003`** — conservative, report-only rewrites (strip separators; 8-digit starting 6/7 → `+591` prefix; `591`-prefixed → `+`); ambiguous/colliding rows skipped + logged, never guessed. Justification (exploration WARNING): free-text vs E.164 silently misses; existing patients are exactly the reminder target, so deferring leaves both capabilities broken at launch. No CHECK constraint (legacy formats stay representable).

## Capabilities (contract with sdd-spec)

### New Capabilities
- `whatsapp-bot`: template lifecycle + outbound dispatch + webhook/status + conversational debt bot.

### Modified Capabilities
- `payment-plans`: ADD patient-scoped debt read (by `patient_id`, not `user_id`) — hybrid patients.
- `patient-management`: canonical phone format requirement + data-quality migration convention (spec-phase decision on placement).

## Approach

- **Meta Cloud API direct** (exploration recommendation: cheapest official utility/service rates, full webhook + template control; Twilio = drop-in behind same port).
- **Module sketch** `src/whatsapp/`: module; office controller (template CRUD, dispatch trigger/retry, `@Auth(OFFICE, ADMIN)`); public webhook controller; services (dispatch, bot, webhook); `entities/`; `dto/`; `provider/` (interface + meta adapter + mock + factory); `phone-normalizer.ts`; `webhook-signature.service.ts` (constant-time HMAC over raw bytes).
- **`main.ts`**: `NestFactory.create(AppModule, { rawBody: true })` — REQUIRED for `x-hub-signature-256`; verify-then-parse, answer 200 fast, dedupe by `wamid`.
- **Dispatch**: transaction (row `queued` + audit) → `sendTemplate` → wamid/status → webhook updates idempotently; retry only from `queued|failed`.
- **Bot**: webhook → dedupe → find-or-create conversation (wa_id) → phone match; else request `identity_document` (state `awaiting_document`) → verify → `identified` → intent (menu: saldo/cuotas/próxima) → debt summary (`outstanding_balance`, next due, overdue total; decimal strings) → free-form reply (24h CSW) → `bot_messages` + audit in one transaction.
- **New enums** in `src/common/enums` (per-file + index.ts): `dispatch-status`, `bot-direction`, `bot-conversation-state`, `template-category`, `template-status`.
- **Env** (`.env.template`/`.env.test`): `WHATSAPP_PROVIDER`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_WABA_ID`, `WHATSAPP_WEBHOOK_PATH`. HTTP: native `fetch` (zero deps).

## Data Model Thinking (design owns final schema)

| Table | Key columns / constraints / notes |
|---|---|
| `message_templates` | uuid PK; name; category enum(utility\|marketing\|authentication); language; body_template (`{{1}}`); sample_variables jsonb; status enum(draft\|submitted\|approved\|rejected\|paused); provider_template_id; provider_status; is_active; created_by_user_id FK→users NULL; timestamps |
| `whatsapp_dispatches` | uuid PK; patient_id FK→patients; template_id FK→message_templates; status enum(queued\|sent\|delivered\|read\|failed); provider_message_id UNIQUE (wamid, dedupe); provider_error; payload jsonb (non-PII); phone snapshot; created_by_user_id; sent_at; idx status |
| `bot_conversations` | uuid PK; patient_id FK NULL till identified; wa_id UNIQUE indexed; state enum(unidentified\|awaiting_document\|identified); last_activity_at; started_at/ended_at |
| `bot_messages` | uuid PK; conversation_id FK→bot_conversations; direction enum(inbound\|outbound); body; provider_message_id UNIQUE; type; template_id FK NULL; intent; metadata jsonb; idx conversation_id |

Conventions preserved: `gen_random_uuid()` PKs; `pk_/uq_/idx_/fk_/chk_` naming; `ON DELETE NO ACTION`; enums via `CREATE TYPE` in migration; hot indexes (wa_id, dispatch status, provider_message_id).

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/whatsapp/` | New | module: entities, dto, services, controllers, provider adapter, webhook, normalizer, signature |
| `src/database/migrations/1786000000003-WhatsAppBot.ts` | New | 4 tables + enums + FKs + indexes + phone data pass (+ colocated migration spec) |
| `src/common/enums/` | Modified | 5 new enum files + index.ts + enums.spec.ts |
| `src/main.ts` | Modified | `rawBody: true` |
| `src/app.module.ts` | Modified | register WhatsappModule |
| `src/payment-plans/` | Modified | patient-scoped debt read (hybrid) |
| `src/audit/` | None | new action strings only; contract already fits |
| `src/test-utils/` | Modified | fake provider + signature test double |
| `.env.template`, `.env.test` | Modified | `WHATSAPP_*` vars |
| `docs/mapeo-es-en.md`, `docs/diccionario-de-datos.md` | Modified | column mapping detail for 4 tables; canonical phone format |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| CRITICAL: Meta onboarding (business verification, WABA, number/display approval, opt-in, template approval days) blocks production activation | High | mock provider in CI; env-driven config; manual smoke with test WABA; tracked external precondition |
| CRITICAL: webhook spoofing if signature misses raw body | Med | `rawBody: true`; verify-then-parse; constant-time compare; unit tests with known app secret; wamid dedupe |
| Phone normalization silent misses | High | lookup normalizer + conservative migration pass; canonical format documented |
| PII in bot_messages/audit JSONB (identity doc, debt, phone) | Med | minimal audit payloads (no full bodies); retention decision in spec; TLS at rest |
| Template cost/policy: marketing-vs-utility mislabel (~6x cost, cap error 131049) | Med | utility enforced for reminders; category guidance in UI |
| Testing without real WhatsApp | Med | provider interface + fake; integration asserts provider never called |
| Scope creep into cron/queue | Med | explicit non-goals; no new deps |

## Rollback Plan

- Migration additive: `down()` drops the 4 tables; phone pass writes from a one-time backup table, `down()` restores original values.
- Disable instantly: `WHATSAPP_PROVIDER=mock` (no real sends; webhook verify fails closed).
- Revert commit: no existing API/behavior changed; `rawBody` flag additive; feature only via new `/api/whatsapp/*` routes.

## Dependencies

- External: Meta WABA + business verification + phone number + app secret + opt-in evidence (production precondition, tracked; test WABA for smoke).
- Internal: Node 20 native `fetch` (no new deps); existing AuditService, auth guards, decimal-string money.

## Open Questions for Spec/Design

1. Bot reply outside the 24h CSW: fall back to a utility template or refuse? (cost/UX)
2. Identification abuse: attempt limits/lockout on `identity_document` retries?
3. Dispatch retry policy: max retries, backoff, manual-only?
4. Audit payload PII: exact allowed fields for dispatch/bot JSONB.
5. Template validation: strict `{{1}}` ↔ DTO variable mapping; rejection semantics.
6. Landline/foreign phones: canonical format or free-text outside the +591-mobile heuristic?
7. Conversation lifecycle: single active conversation per wa_id (uq) vs history; `ended_at` semantics.

## Delivery Shape (size flag — tasks phase owns the final forecast)

- Big change: expected >1000 authored lines. `Chained PRs recommended: Yes`; `400-line budget risk: High`; `Decision needed before apply: Yes` (delivery strategy ask-on-risk).
- Proposed slices: (1) migration + entities + enums + provider port/mock + normalizer + docs; (2) template CRUD + Meta submission/mirror; (3) dispatch flow + adapter + retry; (4) webhook + signature + status idempotency; (5) bot conversation + patient-scoped debt read; (6) env/polish + integration evidence + smoke guide.

## Success Criteria

- [ ] `npm run test:integration` green; provider NEVER called in tests (mock asserted).
- [ ] Office/admin: create template (submitted→approved mirroring), dispatch reminder (queued→sent→delivered via webhook), retry failed; audit rows with new actions in-transaction.
- [ ] Hybrid patient (`user_id` NULL): texts number → identified via phone+identity_document → receives balance/next/overdue summary; `bot_messages` persisted; duplicate webhook deliveries ignored.
- [ ] Unauthenticated webhook POST rejected; valid signature processes exactly once per wamid.
- [ ] Phone data pass normalized canonical rows; ambiguous skipped and logged.
- [ ] `mapeo-es-en.md` + `diccionario-de-datos.md` document the 4 tables and canonical phone format.
