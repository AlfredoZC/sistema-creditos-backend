# Delta for patient-management

## ADDED Requirements

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