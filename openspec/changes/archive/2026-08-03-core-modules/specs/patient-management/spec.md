# Delta for patient-management

## ADDED Requirements

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
