# Patient Management Specification

## Requirements

### Requirement: Patient Registration (Hybrid Account Model)

The system MUST store patients in `patients` with `id` uuid PK, `user_id` uuid NULL UNIQUE FK→users, `identity_document` varchar(20) NOT NULL UNIQUE, `first_name` varchar(50) NOT NULL, `paternal_last_name` varchar(50) NOT NULL, `maternal_last_name` varchar(50) NULL, `birth_date` date NULL, `address` varchar(100) NULL, `phone` varchar(50) NOT NULL UNIQUE.

A patient MAY exist without a web account (`user_id` NULL) — the hybrid model: office/admin register patients who are identified later by the WhatsApp bot via `phone` (primary identity) and `identity_document` (second verification factor).

#### Scenario: Patient registered without web account

- GIVEN an authenticated office or admin user
- WHEN they register a patient with identity_document, first_name, paternal_last_name, phone and no credentials
- THEN the patient row is created with `user_id` NULL
- AND no `users` row is created

#### Scenario: Duplicate phone rejected

- GIVEN an existing patient with phone "+59170000001"
- WHEN a registration is attempted with the same phone
- THEN the request MUST fail with 409 Conflict and no row is created

#### Scenario: Duplicate identity document rejected

- GIVEN an existing patient with identity_document "1234567"
- WHEN a registration is attempted with identity_document "1234567"
- THEN the request MUST fail with 409 Conflict

#### Scenario: Web account linked later

- GIVEN a patient with `user_id` NULL and a `users` row with role `patient`
- WHEN the patient is linked to that user
- THEN `patients.user_id` is set
- AND linking a user already linked to another patient MUST fail with 409 Conflict

### Requirement: Patient Query and Update

Office and admin users MUST be able to list (paginated) and read any patient. A user with role `patient` MUST only read their own linked patient record. Updates MUST re-validate the phone and identity_document uniqueness constraints.

#### Scenario: Patient reads own record

- GIVEN a patient-role user linked to patient P
- WHEN they request their patient profile
- THEN they receive P's data
- AND requesting any other patient MUST return 403 Forbidden

#### Scenario: Office lists patients paginated

- GIVEN an office user and 25 patients
- WHEN they list patients with limit=10, offset=0
- THEN they receive 10 patients and the call accepts the shared PaginationDto contract

### Requirement: Canonical Phone Format

The canonical phone format MUST be E.164-ish `+591XXXXXXXX` (country code 591 + 8-digit national number; mobile starts with 6 or 7). Registration and update SHALL store the canonical form whenever input deterministically matches the +591-mobile heuristic (8 digits starting 6/7, `591`-prefixed, with or without separators); all other inputs — landlines, foreign numbers, ambiguous strings — MUST be stored as provided, never guessed. (Spec decision Q6: landlines and foreign numbers stay free-text; only deterministic +591-mobile rewrites are applied.) No CHECK constraint on `patients.phone` (legacy formats stay representable). Every phone comparison, including WhatsApp `wa_id` matching, MUST normalize both sides with the shared pure normalizer before comparing.

#### Scenario: Mobile input canonicalized

- GIVEN registration input "70000001" or "59170000001"
- WHEN the patient is stored
- THEN phone is "+59170000001"

#### Scenario: Landline or foreign stored as-is

- GIVEN registration input "24000000" (landline) or "+541123456789" (foreign)
- WHEN the patient is stored
- THEN the phone is stored exactly as provided

#### Scenario: Legacy format matches canonical at lookup

- GIVEN an existing patient with phone "+591 7000-0001"
- WHEN a lookup compares it to wa_id "59170000001"
- THEN both normalize to "+59170000001" and match

### Requirement: Phone Data-Quality Migration Convention

The phone data pass in migration `1786000000003-WhatsAppBot.ts` MUST be conservative and report-only: rewrite ONLY safe deterministic forms (strip separators; 8-digit starting 6/7 → prepend +591; `591`-prefixed → prepend +); rows whose normalized form collides with another row, or that do not match the heuristic (landlines, foreign, ambiguous), MUST be skipped and logged — never guessed, merged, or deleted. `down()` MUST restore original values from a one-time backup table. Every rewritten and every skipped row MUST be listed in the migration output.

#### Scenario: Safe rewrite logged

- GIVEN a row with phone "700-00001" and no normalized collision
- WHEN the pass runs
- THEN the phone is rewritten to "+59170000001" and the rewrite is logged

#### Scenario: Collision skipped

- GIVEN two rows with "+59170000001" and "59170000001"
- WHEN the pass runs
- THEN both rows are skipped and logged, and neither is modified

#### Scenario: Rollback restores originals

- GIVEN the pass has run
- WHEN down() executes
- THEN original phone values are restored from the backup table
