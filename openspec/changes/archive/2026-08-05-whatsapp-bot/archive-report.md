# Archive Report — whatsapp-bot

**Change**: `whatsapp-bot` — WhatsApp outbound template notifications + conversational debt bot
**Archived on**: 2026-08-05
**Archived to**: `openspec/changes/archive/2026-08-05-whatsapp-bot/`
**Mode**: openspec (file-based)

## Summary

The change delivered the WhatsApp Bot capability end-to-end: manual outbound template dispatches (office/admin), a conversational debt bot serving hybrid patients (`user_id` NULL), template lifecycle with Meta submission + approval mirroring, a signature-verified public webhook (raw-body HMAC-SHA256, verify-then-parse, wamid dedupe), a patient-scoped debt summary read (service-only), phone canonicalization (`+591XXXXXXXX` normalizer + conservative migration data pass with backup/restore), and the corresponding ES→EN documentation (`mapeo-es-en.md`, `diccionario-de-datos.md`, `whatsapp-smoke-guide.md`).

## What Was Delivered (final state at close)

- **New capability spec `whatsapp-bot`** synced to `openspec/specs/whatsapp-bot/spec.md` (9 requirements, 21 scenarios).
- **Modified capabilities** synced: `patient-management` (+2 requirements: Canonical Phone Format, Phone Data-Quality Migration Convention), `payment-plans` (+1 requirement: Patient-Scoped Debt Summary Read).
- **Implementation** (per persisted tasks, all 32/32 complete): `src/whatsapp/` feature module (templates/dispatches/webhook controllers + services, bot service, provider port + mock + Meta adapter + factory, phone normalizer, intent parser, webhook signature service, entities, DTOs), 5 shared enums in `src/common/enums/`, migration `1786000000003-WhatsAppBot.ts` (5 enum types, backup table, 4 tables, conservative phone data pass, `down()` restore), `PaymentPlansService.getPatientDebtSummary`, `main.ts`/test-app `rawBody: true`, `WHATSAPP_*` env vars, test utils (webhook client, migration test DB `upToVersion`), Spanish docs.
- **Documented implementation re-scope notes** (accepted during apply, recorded in `tasks.md`): submit-on-create `provider.submitTemplate` call not implemented (templates persist as `draft`; approval mirroring proven via `mirrorProviderStatus` service-level calls); utility-only reminder gate enforced in the bot CSW fallback path rather than at dispatch. These do not affect spec scenario compliance.

## Verification Status (final state, settled evidence)

- **Verdict**: **PASS** — 12/12 requirements, 33/33 scenarios compliant; 0 blockers; 0 critical findings (per `verify-report.md`, validated by `gentle-ai sdd-verify-validate`: valid).
- **Runtime evidence** (native attempt ledger, terminal): VERIFY objective COMPLETE, attempt ordinal 30 outcome `passed`, request-id `verify-whatsapp-bot-settle-003`, evidence-revision `sha256:26ac10dd35d84986dd6c2707d6c2051fd9c48607f583f5ccdaea384ef990253d`. Full suite green: **44/44 suites, 502/502 tests, exit 0**; `npm run build` exit 0. Frozen candidate tree `2f71dd1e3b72b5f370a507de8f9e092d23ac8442` at HEAD `74715f4` (branch `fix/excluded-migration-specs`).
- **W1 remediation** (post-verify, resolved this cycle): both pre-existing migration specs (`auth-single-role.migration.spec.ts`, `core-modules.migration.spec.ts`) updated to tolerate the 4-migration state (fresh-DB count 3→4; legacy-revert tests pop three migrations). Spec-only changes; no production code and no migration 003 modified.
- Earlier FAIL (command-exit evidence only, per `tasks.md` verify note 2026-08-05) is superseded: the two failing suites were the pre-existing exclusions now remediated; superseded by the final-state evidence above.

## Review Status

- **Native bounded review**: APPROVED — lineage `review-ac0622cd9abb41a1`, terminal receipt present (identity `sha256:4255dfc639ad33c4591224ad8b19f98f7baf5a5f25293d84bc78e971e661c8f7`), pre-commit gate result **ALLOW** (`gentle-ai review validate --gate=pre-commit` → allow). 4/4 lens results admitted; verification evidence captured with outcome `passed`.
- No review-blocking state: not missing, pending, malformed, scope-changed, invalidated, or escalated.

## Spec Sync (delta → main)

| Domain | Action | Details |
|--------|--------|---------|
| whatsapp-bot | Created | Main spec created from ADDED-only delta: 9 requirements, 21 scenarios |
| patient-management | Updated | 2 requirements appended (Canonical Phone Format, Phone Data-Quality Migration Convention); existing requirements preserved |
| payment-plans | Updated | 1 requirement appended (Patient-Scoped Debt Summary Read); existing requirements preserved |

## Task Completion

All 32/32 implementation tasks checked in the persisted `tasks.md`. No stale unchecked checkboxes; no archive-time reconciliation was needed.

## Follow-ups (open items for future changes)

1. **Migration-count brittleness**: W1 changed `auth-single-role.migration.spec.ts` and `core-modules.migration.spec.ts` to assert a fresh-DB migration count of `toBe(4)`. Any future migration that changes the fresh-DB count again (5 or more migrations) will break these two specs — they must be updated in lockstep with the next migration, or made count-agnostic.
2. **Coverage threshold not configured**: `openspec/config.yaml` and `verify` keep `coverage_threshold: 0`; no coverage gate exists for this change (noted as "Not available" in verify-report).
3. **External production precondition (tracked, not built)**: Meta onboarding (business verification, WABA, phone number approval, opt-in evidence, template approval) is required before `WHATSAPP_PROVIDER=meta` can be used in production; `docs/whatsapp-smoke-guide.md` documents the manual smoke path with a test WABA.
4. **Deferred by design (non-goals)**: scheduled/CRON dispatch, marketing campaigns, multi-language template UI, queue/worker infra, agent handoff, multi-number routing, and the payment-processing spec's cron SHOULD remain unfulfilled.
5. **Design-flagged decisions recorded for future readers**: `bot_message.sent` + `bot_conversation.identification_failed` audit extensions (AD8), `dedupe_key` column (D1), pre-inbound-update CSW window evaluation (AD7), zero-summary shape `nextDueInstallment: null` (D4) — all resolved and verified in this cycle; details in `design.md`.

## Artifacts in Archive

- `proposal.md` ✅
- `exploration.md` ✅
- `specs/` (patient-management, payment-plans, whatsapp-bot) ✅
- `design.md` ✅
- `tasks.md` ✅ (32/32 tasks complete)
- `verify-report.md` ✅ (verdict PASS)
- `archive-report.md` ✅ (this file)
