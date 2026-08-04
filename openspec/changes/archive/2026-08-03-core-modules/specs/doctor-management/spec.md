# Delta for doctor-management

## ADDED Requirements

### Requirement: Doctor Registration (Mandatory Web Account)

The system MUST store doctors in `doctors` with `id` uuid PK, `user_id` uuid NOT NULL UNIQUE FK→users, `specialty` text NOT NULL, `professional_license` text NOT NULL UNIQUE. Every doctor MUST have a web account (the doctor panel is their work tool); account and doctor row MUST be created atomically in one DB transaction. Only office or admin users MAY create doctor accounts; the created `users` row MUST have role `doctor`.

#### Scenario: Office creates a doctor

- GIVEN an authenticated office user
- WHEN they create a doctor with email, password, name, specialty, professional_license
- THEN a `users` row with role `doctor` and a `doctors` row are created in one transaction
- AND the password is stored bcrypt-hashed, never in plain text

#### Scenario: Duplicate professional license rejected

- GIVEN an existing doctor with professional_license "MED-100"
- WHEN a creation is attempted with professional_license "MED-100"
- THEN the request MUST fail with 409 Conflict
- AND the `users` row MUST NOT be created (transaction rollback)

#### Scenario: Patient role cannot create doctors

- GIVEN an authenticated patient-role user
- WHEN they attempt to create a doctor
- THEN the request MUST fail with 403 Forbidden

### Requirement: Doctor Query and Update

Office and admin MUST be able to list (paginated) and read any doctor. A doctor-role user MUST be able to read their own doctor record. Updating `specialty` or `professional_license` MUST re-validate license uniqueness.

#### Scenario: Doctor reads own record

- GIVEN a doctor-role user linked to doctor D
- WHEN they request their doctor profile
- THEN they receive D's data including specialty and professional_license

#### Scenario: License update collision rejected

- GIVEN doctors D1 (license "MED-100") and D2 (license "MED-200")
- WHEN D2 is updated to professional_license "MED-100"
- THEN the request MUST fail with 409 Conflict
