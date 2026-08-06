```yaml
schema: gentle-ai.verify-result/v1
evidence_revision: sha256:26ac10dd35d84986dd6c2707d6c2051fd9c48607f583f5ccdaea384ef990253d
verdict: pass
blockers: 0
critical_findings: 0
requirements: 12/12
scenarios: 33/33
test_command: npm test -- --runInBand
test_exit_code: 0
test_output_hash: sha256:26ac10dd35d84986dd6c2707d6c2051fd9c48607f583f5ccdaea384ef990253d
build_command: npm run build
build_exit_code: 0
build_output_hash: sha256:26ac10dd35d84986dd6c2707d6c2051fd9c48607f583f5ccdaea384ef990253d
```

# SDD Verify Report — whatsapp-bot

**Change**: whatsapp-bot
**Version**: delta specs (patient-management, payment-plans, whatsapp-bot)
**Mode**: Standard (strict TDD evidence consumed from the settled native runtime attempt ledger)

> **Evidence provenance**: this report is produced from the settled native runtime attempt ledger ONLY (gentle-ai sdd-attempt, request-id `verify-whatsapp-bot-settle-003`, attempt ordinal 30, outcome `passed`, evidence-revision `sha256:26ac10dd…`), the preserved code tree at HEAD `74715f4` (branch `fix/excluded-migration-specs`, frozen candidate tree `2f71dd1e3b72b5f370a507de8f9e092d23ac8442`), and the approved native bounded review (lineage `review-ac0622cd9abb41a1`, receipt present, pre-commit gate `allow`). No test, build, or runtime command was re-executed during this verify: the ledger is terminal (`complete`), so a fresh acquire is not authorized. The settled ledger preserves a single canonical evidence digest for the passing run; `test_output_hash` and `build_output_hash` bind to that canonical evidence revision (raw stdout digests are not separately preserved post-settlement).

## Verdict

**PASS** — 12/12 requirements and 33/33 scenarios compliant with passing runtime evidence; full suite green (44/44 suites, 502/502 tests); build green; no blockers, no critical findings. The two pre-existing migration-spec exclusions that caused the previous FAIL (command-exit evidence only) were remediated in W1: both specs now tolerate the 4-migration state (fresh-DB count 3→4) and the legacy-revert tests pop three migrations. Archive-ready.

## Completeness

| Metric | Value |
|--------|-------|
| Tasks total | 32 |
| Tasks complete | 32 |
| Tasks incomplete | 0 |

## Build & Tests Execution (settled evidence, attempt ordinal 30)

**Build**: ✅ Passed
```text
npm run build → exit code 0
```

**Tests**: ✅ 502 passed / 0 failed / 0 skipped (44/44 suites)
```text
npm test -- --runInBand → exit code 0 — 44 suites passed, 502 tests passed, 0 failures
```

**Coverage**: ➖ Not available (no coverage threshold configured for this change)

W1 remediation (commits `79c617f`, `1df35aa`, `4a0dfea`, `74715f4` on `fix/excluded-migration-specs`), verified in the tree:
- `src/database/migrations/auth-single-role.migration.spec.ts` — fresh-DB migration count `toBe(4)` (line 39); legacy-revert tests now `undoLastMigration()` ×3 (003→002→001) so the legacy `roles`/`lastName` Init schema is restored and revert-restore/ES schema-alignment assertions pass with 003 applied.
- `src/database/migrations/core-modules.migration.spec.ts` — fresh-DB migration count `toBe(4)` (line 232).
- No production code and no migration 003 modified.

## Spec Compliance Matrix (12 requirements / 33 scenarios)

### patient-management — Canonical Phone Format

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-01 Canonical Phone Format | Mobile input canonicalized | `src/whatsapp/phone-normalizer.spec.ts` > "Mobile input canonicalized" (8-digit 6/7, `591`-prefixed, separators stripped, already-canonical unchanged) + `src/patients/patients.service.ts` normalization (patients spec green) | ✅ COMPLIANT |
| REQ-01 Canonical Phone Format | Landline or foreign stored as-is | `src/whatsapp/phone-normalizer.spec.ts` > "Landline or foreign stored as-is" (landline kept as provided; foreign kept as provided, separators stripped) | ✅ COMPLIANT |
| REQ-01 Canonical Phone Format | Legacy format matches canonical at lookup | `src/whatsapp/phone-normalizer.spec.ts` > "Legacy format matches canonical at lookup" + `src/whatsapp/bot.service.spec.ts` > "matches a legacy-format wa_id against the canonical patient phone (left-normalized lookup)" | ✅ COMPLIANT |

### patient-management — Phone Data-Quality Migration Convention

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-02 Phone Data-Quality Migration Convention | Safe rewrite logged | `src/database/migrations/whatsapp-bot.migration.spec.ts` > "phone pass rewrites safe rows with backup and leaves collisions, non-heuristic rows, and canonical rows exactly as the runtime normalizer predicts" (rewrite + backup-row assertions; migration console lists REWRITE/SKIP rows per design §5.6) | ✅ COMPLIANT |
| REQ-02 Phone Data-Quality Migration Convention | Collision skipped | `src/database/migrations/whatsapp-bot.migration.spec.ts` > same test — collision pair `+59170000001` / `59170000001` asserted skipped as a pair, both rows untouched, no backup rows | ✅ COMPLIANT |
| REQ-02 Phone Data-Quality Migration Convention | Rollback restores originals | `src/database/migrations/whatsapp-bot.migration.spec.ts` > "down() restores original phones, drops the backup table, the four business tables, and the five enum types" | ✅ COMPLIANT |

### payment-plans — Patient-Scoped Debt Summary Read

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-03 Patient-Scoped Debt Summary Read | Hybrid patient summary | `src/payment-plans/payment-plans.spec.ts` > "returns the hybrid patient summary with pinned values 8155.19 / 1113.27 / 2026-08-05 / 613.27" (decimal strings, next due installment 2) | ✅ COMPLIANT |
| REQ-03 Patient-Scoped Debt Summary Read | No plan yields zero summary | `src/payment-plans/payment-plans.spec.ts` > "returns the zero summary for a patient without a payment plan" + `src/whatsapp/bot.service.spec.ts` > "answers saldo with the zero summary for a patient without a plan" | ✅ COMPLIANT |
| REQ-03 Patient-Scoped Debt Summary Read | Not exposed to patient-role users | `src/payment-plans/payment-plans.spec.ts` > "exposes no HTTP surface for the summary while patient own-record reads keep working" (service-only read; patient own-record reads unchanged) | ✅ COMPLIANT |

### whatsapp-bot — Template Lifecycle and Variable Validation

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-04 Template Lifecycle and Variable Validation | Rejected, paused, or deactivated blocked | `src/whatsapp/dispatches.service.spec.ts` > "rejects a non-dispatchable template with 409 and no row or provider call" + "rejects a deactivated approved template with 409" + `src/whatsapp/templates.spec.ts` > "rejected, paused, and draft statuses block dispatch with 409 (same gate branch, no row or provider call)" | ✅ COMPLIANT |
| REQ-04 Template Lifecycle and Variable Validation | Placeholder mismatch rejected | `src/whatsapp/dispatches.service.spec.ts` > "rejects missing, extra, or empty variables with 400 and no row, audit, or provider call" + `src/whatsapp/dispatches.spec.ts` > "rejects variables that do not map 1:1 to placeholders with 400" + `src/whatsapp/templates.spec.ts` > "missing, extra, and empty variables → 400 with no row, audit, or provider call" | ✅ COMPLIANT |

### whatsapp-bot — Outbound Dispatch Trigger

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-05 Outbound Dispatch Trigger | Happy path dispatch | `src/whatsapp/dispatches.spec.ts` > "happy path: 201, row commits queued + audit, provider called after commit, then sent with wamid" + `src/whatsapp/dispatches.service.spec.ts` > "happy path: commits queued + audit, then sends and becomes sent with wamid" | ✅ COMPLIANT |
| REQ-05 Outbound Dispatch Trigger | Duplicate dispatch deduplicated | `src/whatsapp/dispatches.spec.ts` > "deduplicates identical requests: second POST gets 409, one row, one provider call" + "deduplicates two concurrent identical POSTs into one row and one provider call; loser gets 409" + `src/whatsapp/dispatches.service.spec.ts` > concurrent dedupe + canonicalJson key-order stability | ✅ COMPLIANT |
| REQ-05 Outbound Dispatch Trigger | Mock provider isolation | `src/whatsapp/dispatches.spec.ts` > "never makes a real network call: fetch never invoked, Meta adapter never constructed" + `src/whatsapp/dispatches.service.spec.ts` > "never makes a real network call: fetch is never invoked during dispatch flows" + `src/whatsapp/whatsapp.module.spec.ts` > "boots AppModule with the mock provider (isolation guarantee)" | ✅ COMPLIANT |
| REQ-05 Outbound Dispatch Trigger | Non-PII payload and phone snapshot | `src/whatsapp/dispatches.service.spec.ts` > "stores only the resolved variables as payload and the normalized phone snapshot" | ✅ COMPLIANT |

### whatsapp-bot — Dispatch Status Transitions and Retry

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-06 Dispatch Status Transitions and Retry | Failed dispatch retried | `src/whatsapp/dispatches.spec.ts` > "retries a failed dispatch through queued to sent with a new wamid and audits" + `src/whatsapp/dispatches.service.spec.ts` > same (status_changed audits on re-route and send) | ✅ COMPLIANT |
| REQ-06 Dispatch Status Transitions and Retry | Terminal status cannot be retried | `src/whatsapp/dispatches.spec.ts` > "rejects retry of a terminal delivered dispatch with 409 and no provider call" + `src/whatsapp/dispatches.service.spec.ts` > "rejects retry of a terminal delivered dispatch with 409 and no provider call" | ✅ COMPLIANT |
| REQ-06 Dispatch Status Transitions and Retry | Attempt limit reached | `src/whatsapp/dispatches.spec.ts` > "rejects retry at the attempt limit with 409 after 3 send attempts" + `src/whatsapp/dispatches.service.spec.ts` > "rejects retry at the attempt limit with 409 and never violates the send_attempts CHECK" | ✅ COMPLIANT |

### whatsapp-bot — Webhook Contract: Handshake and Signature

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-07 Webhook Contract: Handshake and Signature | Valid handshake echoes challenge | `src/whatsapp/webhook.spec.ts` > "echoes the challenge as plain text with 200" | ✅ COMPLIANT |
| REQ-07 Webhook Contract: Handshake and Signature | Invalid token rejected | `src/whatsapp/webhook.spec.ts` > "rejects a non-matching verify_token with 403" | ✅ COMPLIANT |
| REQ-07 Webhook Contract: Handshake and Signature | Tampered POST rejected unprocessed | `src/whatsapp/webhook.spec.ts` > "rejects a tampered POST (wrong signature) with 403 and processes nothing" + "rejects a POST without signature header with 401 and processes nothing" + `src/whatsapp/webhook-signature.spec.ts` (PINNED vector + self-computed vector + mismatch/missing-header/length/prefix/invalid-hex) | ✅ COMPLIANT |

### whatsapp-bot — Webhook Status and Inbound Processing

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-08 Webhook Status and Inbound Processing | Duplicate delivery ignored | `src/whatsapp/webhook.spec.ts` > "ignores a duplicate delivery: 200, no state change, NO new audit" + `src/whatsapp/bot.service.spec.ts` > "returns a silent no-op for a duplicate message id: one bot_message row, one reply" + `src/whatsapp/bot.spec.ts` > "two deliveries of the same message id persist ONE bot_message row and ONE reply" | ✅ COMPLIANT |
| REQ-08 Webhook Status and Inbound Processing | Out-of-order status does not regress | `src/whatsapp/webhook.spec.ts` > "does not regress on out-of-order statuses: late sent after delivered is a 200 no-op" | ✅ COMPLIANT |

### whatsapp-bot — Conversation Lifecycle

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-09 Conversation Lifecycle | Existing conversation reused | `src/whatsapp/bot.service.spec.ts` > "answers saldo with the debt decimal strings and reuses the same conversation" (find-or-create by unique wa_id, history accumulation) | ✅ COMPLIANT |

### whatsapp-bot — Patient Identification

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-10 Patient Identification | Single phone match identifies | `src/whatsapp/bot.spec.ts` > "identifies a hybrid patient (user_id NULL) on a single phone match and answers saldo with the pinned decimal strings" + `src/whatsapp/bot.service.spec.ts` > "identifies on a single phone match, persists the inbound message, and replies with the menu" | ✅ COMPLIANT |
| REQ-10 Patient Identification | No match requests document | `src/whatsapp/bot.spec.ts` > "requests the identity document when no patient phone matches the wa_id" + `src/whatsapp/bot.service.spec.ts` > "enters awaiting_document and requests the identity document when no phone matches" | ✅ COMPLIANT |
| REQ-10 Patient Identification | Correct document identifies | `src/whatsapp/bot.spec.ts` > "identifies on the correct document when the phone matches more than one patient" + `src/whatsapp/bot.service.spec.ts` > "identifies when the document matches a phone candidate (case and whitespace insensitive)" | ✅ COMPLIANT |
| REQ-10 Patient Identification | Soft lock after three failures | `src/whatsapp/bot.spec.ts` > "soft-locks after three failures and ignores further attempts: guidance re-sent, NO increment" + "after lockout expiry the next failure counts as attempt 1 — windowed max-3-per-24h, CHECK 23514 unreachable" + `src/whatsapp/bot.service.spec.ts` > lockout/guidance/expiry-reset tests | ✅ COMPLIANT |

### whatsapp-bot — Debt Query and Reply

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-11 Debt Query and Reply | Saldo intent answered | `src/whatsapp/bot.spec.ts` > "identifies a hybrid patient … and answers saldo with the pinned decimal strings" (outstanding 8155.19, next due 1113.27 / 2026-08-05, overdue 613.27) + `src/whatsapp/bot.service.spec.ts` > "answers saldo with the debt decimal strings" / "answers cuotas with the next-due installment detail" / "answers proxima with the next-due date (diacritics normalized)" | ✅ COMPLIANT |
| REQ-11 Debt Query and Reply | Outside CSW template fallback | `src/whatsapp/bot.spec.ts` > "after 24h of inactivity replies ONLY via an approved+active utility template — never free-form" + `src/whatsapp/bot.service.spec.ts` > "sends only via an approved+active utility template out-of-window — never free-form" + "records the failure in metadata and sends NOTHING when no utility template exists" | ✅ COMPLIANT |

### whatsapp-bot — Bot Message and Audit Persistence

| Requirement | Scenario | Test | Result |
|-------------|----------|------|--------|
| REQ-12 Bot Message and Audit Persistence | Message and audit atomic | `src/whatsapp/bot.spec.ts` > "a rollback mid-reply removes BOTH the outbound bot_message row and its audit" + `src/whatsapp/bot.service.spec.ts` > "rolls back the outbound message AND its audit together (message+audit atomicity)" | ✅ COMPLIANT |
| REQ-12 Bot Message and Audit Persistence | Actor vs system attribution | `src/whatsapp/bot.spec.ts` > "manual dispatch audits carry the office user; bot audits carry NULL" + `src/whatsapp/dispatches.spec.ts` > "audits a system-triggered dispatch (service userId null) with user_id NULL" | ✅ COMPLIANT |
| REQ-12 Bot Message and Audit Persistence | No PII in audit payloads | `src/whatsapp/bot.spec.ts` > "bot audits never carry wa_id, identity documents, message bodies, or debt amounts" + `src/whatsapp/bot.service.spec.ts` > "never stores wa_id, documents, message bodies, or debt amounts in audit payloads" + `src/whatsapp/templates.spec.ts` > "full lifecycle audits only whatsapp_template.created/updated/status_changed with operational fields only" | ✅ COMPLIANT |

**Compliance summary**: 33/33 scenarios compliant (12/12 requirements).

## Correctness (Static Evidence)

| Requirement | Status | Notes |
|------------|--------|-------|
| REQ-01 Canonical Phone Format | ✅ Implemented | `src/whatsapp/phone-normalizer.ts` (pure `normalizePhone` / `phoneMatchesLeftNormalized`), applied at `patients.service.ts` create/update boundary; wa_id lookups normalize both sides |
| REQ-02 Phone Data-Quality Migration Convention | ✅ Implemented | `src/database/migrations/1786000000003-WhatsAppBot.ts`: 5 enum types, backup table, 4 tables, phone pass (rewrite/collision/no-heuristic skip + console report), `down()` restore |
| REQ-03 Patient-Scoped Debt Summary Read | ✅ Implemented | `PaymentPlansService.getPatientDebtSummary` — service-only, consumed by `WhatsappModule`, no route (spec "Not exposed": 404/no surface) |
| REQ-04 Template Lifecycle and Variable Validation | ✅ Implemented | `templates.service.ts` + controller (CRUD + deactivate), dispatch gate (approved AND active), strict 1:1 placeholder↔variable validation, status mirroring via `mirrorProviderStatus` |
| REQ-05 Outbound Dispatch Trigger | ✅ Implemented | `dispatches.service.ts`: in-tx row `queued` + audit, dedupe_key sha256 UNIQUE, phone snapshot, non-PII payload, provider call after commit, wamid + `sent`/`failed` |
| REQ-06 Dispatch Status Transitions and Retry | ✅ Implemented | state machine + manual retry from `queued\|failed`, `send_attempts` ≤ 3 with DB CHECK, terminal 409 |
| REQ-07 Webhook Contract: Handshake and Signature | ✅ Implemented | GET handshake (200/400/403), HMAC-SHA256 over raw body (`rawBody: true`), `crypto.timingSafeEqual`, verify-then-parse |
| REQ-08 Webhook Status and Inbound Processing | ✅ Implemented | wamid dedupe (UNIQUE), effective-transition-only status updates, out-of-order no-regress, inbound message dedupe |
| REQ-09 Conversation Lifecycle | ✅ Implemented | find-or-create by normalized wa_id (UNIQUE), state enum, `last_activity_at` per inbound |
| REQ-10 Patient Identification | ✅ Implemented | normalized phone match, `awaiting_document` + identity_document verification, max 3 attempts / 24h soft lockout with expiry reset |
| REQ-11 Debt Query and Reply | ✅ Implemented | intent menu (saldo/cuotas/proxima) via debt read, CSW window evaluated pre-update, utility-template fallback out-of-window |
| REQ-12 Bot Message and Audit Persistence | ✅ Implemented | bot_message + audit in one transaction, action strings incl. `bot_message.sent` (AD8), user_id attribution, operational-only audit payloads (AD9) |

## Coherence (Design)

| Decision | Followed? | Notes |
|----------|-----------|-------|
| D1 dedupe_key UNIQUE + 409 | ✅ Yes | `sha256(patient_id‖template_id‖created_by_user_id‖canonicalJson(variables))`; canonicalJson key-order stability tested |
| D2 send_attempts max-3 + CHECK + gate | ✅ Yes | CHECK `0..3` in migration; increment-before-send; attempt-limit 409 tested, 23514 never violated |
| D3 self-contained migration phone pass | ✅ Yes | migration copy cross-referenced; migration spec asserts predictions match the runtime normalizer exactly |
| D4 zero-summary shape | ✅ Yes | `nextDueInstallment: null` + `'0.00'`/`'0.00'`; pinned fixture values proven end-to-end |
| AD1 Provider port + mock/meta/factory | ✅ Yes | `WHATSAPP_PROVIDER=mock|meta`, fail-fast on unknown; mock is the runtime AND integration fake |
| AD2 Native fetch + timeout | ✅ Yes | Meta adapter unit-tested with mocked global fetch (success, HTTP error, Meta code, timeout) |
| AD3 rawBody + verify-then-parse | ✅ Yes | `main.ts` + test-app `rawBody: true`; signature gate before any parsing/persistence |
| AD4 Public webhook controller | ✅ Yes | `@Controller(WHATSAPP_WEBHOOK_PATH ?? 'whatsapp/webhook')`, no `@Auth()`; JWT-excluded naturally |
| AD5 Provider calls after commit | ✅ Yes | asserted in dispatch + bot reply pipelines |
| AD6 wamid dedupe via UNIQUE + no-op | ✅ Yes | 23505 treated as 200 no-op; effective-transition-only audits |
| AD7 CSW window pre-inbound-update | ✅ Yes | 24h-of-inactivity fixture proves template fallback |
| AD8 `bot_message.sent` audit extension | ✅ Yes | outbound replies audited (required by message+audit atomicity) |
| AD9 Audit PII boundary | ✅ Yes | operational fields only; PII-boundary specs green |
| AD10 Migration self-containment | ✅ Yes | duplicated normalizer + backup/restore inline |

## Issues Found

**CRITICAL**: None
**WARNING**: None
**SUGGESTION**: None (documented implementation re-scope notes from tasks.md — submit-on-create `provider.submitTemplate` call not implemented, template approval mirroring proven via `mirrorProviderStatus` service-level calls; utility-only reminder gate enforced in the bot CSW fallback path — were reviewed and accepted during implementation; they do not affect spec scenario compliance, which is fully green.)

## Native Verification State

- Native runtime attempt ledger: `complete` (terminal), attempt ordinal 30 settled with outcome `passed`, evidence-revision `sha256:26ac10dd35d84986dd6c2707d6c2051fd9c48607f583f5ccdaea384ef990253d`, request-id `verify-whatsapp-bot-settle-003`.
- Native bounded review: APPROVED (lineage `review-ac0622cd9abb41a1`, receipt present, pre-commit gate result `allow`).
- W1 remediation verified in tree: both pre-existing migration specs tolerate the 4-migration state; full regression suite green on the frozen candidate tree `2f71dd1e3b72b5f370a507de8f9e092d23ac8442`.

## Verdict

**PASS** — 12/12 requirements and 33/33 scenarios compliant with passing runtime evidence (44/44 suites, 502/502 tests, exit 0; build exit 0); no blockers, no critical findings; previous command-exit FAIL resolved by W1; archive-ready.
