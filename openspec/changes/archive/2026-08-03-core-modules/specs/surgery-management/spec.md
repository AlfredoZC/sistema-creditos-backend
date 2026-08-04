# Delta for surgery-management

## ADDED Requirements

### Requirement: Surgery Catalog Management

The system MUST store catalog entries in `surgery_catalog` with `id` uuid PK, `name` varchar(50) NOT NULL, `description` text NULL, `base_cost` numeric(10,2) NOT NULL with CHECK `base_cost >= 0`. Office/admin manage the catalog; any authenticated role MAY read it.

#### Scenario: Catalog entry created

- GIVEN an office user
- WHEN they create a catalog entry with name "Appendectomy" and base_cost "8000.00"
- THEN the entry is persisted and readable by all roles

#### Scenario: Negative base cost rejected

- GIVEN an office user
- WHEN they submit base_cost "-1.00"
- THEN the request MUST fail validation and the DB CHECK MUST reject negative values

### Requirement: Surgery Scheduling and Lifecycle

The system MUST store surgeries in `surgeries` with `patient_id` and `surgery_catalog_id` NOT NULL FKs, `scheduled_date` date NOT NULL, `total_cost` numeric(10,2) NOT NULL CHECK `>= 0`, `status` enum `surgery_status` ('scheduled','performed','cancelled') DEFAULT 'scheduled', `notes` text NULL. Status transitions MUST be audited (see audit-logging).

#### Scenario: Surgery scheduled

- GIVEN an existing patient and catalog entry
- WHEN an office user schedules a surgery with scheduled_date and total_cost
- THEN the surgery is created with status 'scheduled'

#### Scenario: Status transition

- GIVEN a surgery with status 'scheduled'
- WHEN an office/admin user marks it 'performed'
- THEN the status is updated and an audit entry is written in the same transaction

#### Scenario: Invalid status rejected

- GIVEN any surgery
- WHEN a transition to a value outside the enum is attempted
- THEN the request MUST fail validation

### Requirement: Doctor Assignment with One-Principal Invariant

The system MUST store assignments in `surgery_doctors` with UNIQUE(`surgery_id`,`doctor_id`) and `role` enum `surgery_doctor_role` ('principal','assistant','anesthesiologist') DEFAULT 'principal'. Exactly one principal per surgery MUST be enforced by a partial unique index on `surgery_id WHERE role='principal'`. Reassigning the principal MUST demote the existing principal and promote the new one in ONE DB transaction.

#### Scenario: Second principal rejected

- GIVEN surgery S already has a principal doctor
- WHEN another doctor is assigned to S with role 'principal' (without reassignment)
- THEN the partial unique index MUST reject the insert

#### Scenario: Principal reassignment is atomic

- GIVEN surgery S with principal D1
- WHEN an office/admin user reassigns the principal to D2
- THEN D1's assignment is demoted (role changed from 'principal') and D2 becomes principal in one transaction
- AND at no observable point does S have zero or two principals

#### Scenario: Same doctor twice rejected

- GIVEN doctor D1 assigned to surgery S
- WHEN D1 is assigned to S again with any role
- THEN UNIQUE(surgery_id, doctor_id) MUST reject the operation
