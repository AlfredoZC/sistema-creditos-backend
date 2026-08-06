# Delta for whatsapp-bot

## ADDED Requirements

### Requirement: Template Lifecycle and Variable Validation

Templates MUST be stored in `message_templates` (uuid PK, `name`, `category` enum utility|marketing|authentication, `language`, `body_template` with `{{1}}` placeholders, `sample_variables` jsonb, `status` enum draft|submitted|approved|rejected|paused, `provider_template_id`, `provider_status`, `is_active`, `created_by_user_id` FK→users NULL). Office/admin MUST create, read, update, and deactivate templates; create/update MUST submit through Meta and mirror provider approval (draft→submitted→approved|rejected|paused). Only 'approved' AND `is_active=true` templates MUST be dispatchable; deactivation MUST block new dispatches without deleting the row. Reminder templates MUST be category 'utility'. `body_template` MUST declare contiguous `{{1}}`…`{{N}}` placeholders with sample values; dispatch variables MUST map 1:1 — missing/extra/empty substitutions MUST be rejected with 400 before any row or provider call. (Spec decision Q5: strict, fail-fast validation.)

#### Scenario: Rejected, paused, or deactivated blocked

- GIVEN a template with status rejected, paused, or is_active=false
- WHEN a dispatch is attempted
- THEN the request MUST fail with 409 Conflict with no row or provider call

#### Scenario: Placeholder mismatch rejected

- GIVEN a template declaring two placeholders
- WHEN a dispatch supplies one, three, or an empty variable
- THEN the request MUST fail with 400 Bad Request with no row, audit, or provider call

### Requirement: Outbound Dispatch Trigger

Office/admin MUST trigger `POST /api/whatsapp/dispatches` with patient + template + variables. In ONE DB transaction the system MUST insert a `whatsapp_dispatches` row (uuid PK, `patient_id` FK→patients, `template_id` FK→message_templates, status 'queued', `payload` jsonb with resolved variables ONLY — no phones, names, identity documents, or debt amounts — `phone` snapshot at dispatch time, `created_by_user_id`) and audit `whatsapp_dispatch.created`. After commit it MUST send via the `WhatsAppProvider` port (`WHATSAPP_PROVIDER=mock|meta`) and record wamid + 'sent' or 'failed' + `provider_error`. Duplicate identical requests MUST NOT create a second row or send. Tests MUST run with the mock and assert the real Meta adapter is never invoked. (Design note: exact indexes/DDL are design-owned.)

#### Scenario: Happy path dispatch

- GIVEN an office user, an approved+active utility template, and a patient
- WHEN they POST the dispatch
- THEN the row commits 'queued' with its audit, the provider is called after commit, and the row becomes 'sent' with a wamid

#### Scenario: Duplicate dispatch deduplicated

- GIVEN two concurrent identical dispatch requests
- WHEN both are processed
- THEN exactly one row and one provider call exist

#### Scenario: Mock provider isolation

- GIVEN the integration suite with WHATSAPP_PROVIDER=mock
- WHEN a dispatch flow runs
- THEN the mock records the send and the tests assert no real network call occurred

#### Scenario: Non-PII payload and phone snapshot

- GIVEN a dispatch is created
- THEN `payload` holds only resolved variables and the phone snapshot equals the patient's phone

### Requirement: Dispatch Status Transitions and Retry

Status MUST follow queued→sent→delivered|read (success terminal) and sent→failed; 'failed' MUST stay retryable. `POST /api/whatsapp/dispatches/:id/retry` MUST be manual, office/admin-only, accepted ONLY from 'queued' or 'failed', and MUST re-route through 'queued' before a new send. (Spec decision Q3: no scheduler/backoff in this change; max 3 send attempts per dispatch — beyond that retry MUST fail 409 and office MUST create a new dispatch.) Effective status changes MUST audit `whatsapp_dispatch.status_changed`.

#### Scenario: Failed dispatch retried

- GIVEN a dispatch with status 'failed'
- WHEN an office user retries
- THEN it passes through 'queued' to 'sent' with a new wamid and a status_changed audit entry

#### Scenario: Terminal status cannot be retried

- GIVEN a dispatch with status 'delivered' or 'read'
- WHEN a retry is attempted
- THEN the request MUST fail with 409 Conflict and no provider call occurs

#### Scenario: Attempt limit reached

- GIVEN a dispatch that already had 3 send attempts
- WHEN a retry is attempted
- THEN the request MUST fail with 409 Conflict

### Requirement: Webhook Contract: Handshake and Signature

The public webhook MUST support the GET handshake: with `hub.mode=subscribe` and `hub.verify_token` matching `WHATSAPP_VERIFY_TOKEN` (constant-time), answer `hub.challenge` as plain text; missing params → 400; mismatch → 403. POSTs MUST be verified BEFORE parsing: HMAC-SHA256 over the RAW body (`rawBody: true`) with `WHATSAPP_APP_SECRET` compared to `x-hub-signature-256` in constant time; missing/mismatched signature → 401/403 with no parsing, persistence, or business data; valid requests get 200 fast. (Spec note: verify-then-parse is mandatory — parse-first is a spoofing vector.)

#### Scenario: Valid handshake echoes challenge

- GIVEN a GET with hub.mode=subscribe, matching verify_token, and challenge "abc123"
- WHEN the handshake is processed
- THEN the response is 200 with body "abc123"

#### Scenario: Invalid token rejected

- GIVEN a GET with a non-matching verify_token
- WHEN the handshake is processed
- THEN the response MUST be 403 Forbidden

#### Scenario: Tampered POST rejected unprocessed

- GIVEN a POST whose x-hub-signature-256 does not match its raw body (or with no header)
- WHEN it arrives
- THEN the request MUST fail with 401/403 and nothing is parsed, persisted, or replied

### Requirement: Webhook Status and Inbound Processing

Verified POSTs MUST be deduplicated by `wamid`: status events (sent|delivered|read|failed) MUST update the matching dispatch by `provider_message_id` idempotently — duplicates and out-of-order statuses MUST NOT regress a more advanced status nor duplicate audits; each effective transition MUST audit `whatsapp_dispatch.status_changed`. Inbound messages MUST be deduplicated by message id before entering the conversation flow so duplicate deliveries never duplicate bot messages.

#### Scenario: Duplicate delivery ignored

- GIVEN a dispatch already processed as 'delivered'
- WHEN the same wamid delivery arrives again
- THEN the response is 200 with no state change and no new audit entry

#### Scenario: Out-of-order status does not regress

- GIVEN a dispatch with status 'delivered'
- WHEN a late 'sent' status for the same wamid arrives
- THEN the dispatch remains 'delivered'

### Requirement: Conversation Lifecycle

Inbound messages MUST find-or-create a `bot_conversations` row keyed by normalized `wa_id`; at most one conversation MUST exist per `wa_id` (unique), reused for all later messages, with `bot_messages` accumulating history. `state` MUST be unidentified|awaiting_document|identified; `started_at` at creation, `last_activity_at` per inbound message. (Spec decision Q7: single active conversation per wa_id for the row's lifetime — no auto-end in this change; `ended_at` stays NULL until an explicit close feature exists.)

#### Scenario: Existing conversation reused

- GIVEN an identified conversation for a wa_id
- WHEN a new inbound message arrives from that wa_id
- THEN the same conversation row is used and the message appends to its history

### Requirement: Patient Identification

Identification MUST compare the normalized `wa_id` against normalized `patients.phone` via the shared normalizer. Exactly one match → 'identified' (patient_id set, audit `bot_conversation.identified`). Zero or multiple matches → 'awaiting_document', and the bot MUST request `identity_document`; the reply MUST verify against candidates and succeed ONLY when the document matches a patient whose normalized phone corresponds to the caller's wa_id — any other outcome counts as a failed attempt. (Spec decision Q2: max 3 failed attempts per 24h per conversation; on the 3rd failure the bot MUST send clinic-contact guidance and ignore further attempts for 24h — soft lockout, never permanent.)

#### Scenario: Single phone match identifies

- GIVEN a wa_id normalizing to exactly one patient's phone
- WHEN the inbound message is processed
- THEN the conversation becomes 'identified' with patient_id set and the identification audited

#### Scenario: No match requests document

- GIVEN a wa_id with no matching patient phone
- WHEN the inbound message is processed
- THEN the conversation enters 'awaiting_document' and the bot requests the identity_document

#### Scenario: Correct document identifies

- GIVEN a conversation in 'awaiting_document'
- WHEN the patient replies with the correct identity_document
- THEN the conversation becomes 'identified'

#### Scenario: Soft lock after three failures

- GIVEN a conversation with 3 failed attempts within 24h
- WHEN another identity_document reply arrives
- THEN it is ignored and the guidance reply is re-sent

### Requirement: Debt Query and Reply

An identified conversation MUST answer the intent menu (saldo|cuotas|próxima) using the patient-scoped debt read: `outstanding_balance`, next due installment (number, amount, date), and overdue total as fixed-point decimal strings. Inside the 24h customer-service window replies MUST be free-form text; (Spec decision Q1: outside the window the bot MUST NOT send free-form replies — it MUST fall back to an approved+active 'utility' template carrying the same summary via variables; if none exists or the send fails, nothing is sent and the failure is recorded.) Every reply MUST be persisted as a bot message.

#### Scenario: Saldo intent answered

- GIVEN an identified conversation inside the CSW
- WHEN the patient sends "saldo"
- THEN the reply includes outstanding_balance, next due amount/date, and overdue total as decimal strings (e.g. "8155.19")

#### Scenario: Outside CSW template fallback

- GIVEN an identified conversation outside the 24h window
- WHEN the patient asks "cuotas"
- THEN the bot sends only via a utility template, never free-form

### Requirement: Bot Message and Audit Persistence

Every bot message MUST be persisted in `bot_messages` (conversation_id FK, direction enum inbound|outbound, `body`, `provider_message_id` UNIQUE, type text|template, template_id NULL, intent NULL, metadata jsonb) in the SAME transaction as its audit entry — a rollback removes both. Audit actions MUST be `whatsapp_dispatch.created`, `whatsapp_dispatch.status_changed`, `whatsapp_template.created|updated|status_changed`, `bot_conversation.started|identified`, `bot_message.received`; `user_id` MUST be the acting office/admin on manual operations, NULL on bot/system; `table_name` the affected table. (Spec decision Q4: audit JSONB MUST NOT contain full message bodies, identity documents, phone numbers, or debt amounts — only operational fields.)

#### Scenario: Message and audit atomic

- GIVEN an inbound message being processed
- WHEN the bot_message row is inserted
- THEN the audit entry commits in the same transaction; on rollback neither exists

#### Scenario: Actor vs system attribution

- GIVEN a manual dispatch by an office user and a bot-generated reply
- WHEN both are audited
- THEN the dispatch audit's user_id is the office user and the bot reply audit's user_id is NULL

#### Scenario: No PII in audit payloads

- GIVEN a `bot_message.received` audit entry
- THEN its JSONB holds only operational fields, never the message body or identity values