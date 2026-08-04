# Delta for user-auth

No main spec exists yet; this delta seeds `user-auth` with the target behavior (the legacy `roles text[]` model is replaced).

## ADDED Requirements

### Requirement: Single-Role User Model

The system MUST store users in `users` with `id` uuid PK, `email` varchar(255) UNIQUE NOT NULL, `password` varchar(255) NOT NULL (bcrypt-hashed, never selected by default), `name` varchar(50) NOT NULL, `is_active` boolean NOT NULL DEFAULT true, and a single `role` of enum `user_role` ('patient','doctor','office','admin') NOT NULL. The legacy `roles text[]` column and the `ValidRoles` values admin/super-user/user MUST NOT be used.

#### Scenario: User created with exactly one role

- GIVEN a registration payload
- WHEN the user is persisted
- THEN `role` holds exactly one of 'patient','doctor','office','admin'

#### Scenario: Legacy role values rejected

- GIVEN a payload with role 'super-user' or 'user'
- WHEN registration is attempted
- THEN the request MUST fail validation

#### Scenario: Legacy roles migrated to single role

- GIVEN an existing user with roles ['admin'] and an existing user with roles ['user'] before the migration
- WHEN the versioned migration runs
- THEN the first element of the legacy array maps to the new `role` ('admin' → 'admin', legacy 'user' → 'patient'), and the `roles` array column is dropped

### Requirement: Role-Based Registration Flows

Self-service registration MUST assign role 'patient' only. Doctor accounts MUST be created by office or admin users (see doctor-management). Office and admin accounts MUST be created by an admin user (or seed). A patient record MAY exist without any user account (hybrid model).

#### Scenario: Public self-registration yields patient role

- GIVEN an unauthenticated caller
- WHEN they register with email, password, name
- THEN the user is created with role 'patient'
- AND any role field in the payload is ignored or rejected

#### Scenario: Non-admin cannot create office accounts

- GIVEN an authenticated office user
- WHEN they attempt to create a user with role 'office' or 'admin'
- THEN the request MUST fail with 403 Forbidden

### Requirement: Authentication

Login MUST validate email + password against the bcrypt hash and issue a JWT whose payload is exactly `{id}` (unchanged contract). Users with `is_active = false` MUST NOT authenticate. `check-status` MUST re-issue a token for a valid, active session.

#### Scenario: Successful login

- GIVEN an active user with email "a@b.com" and correct password
- WHEN they log in
- THEN they receive a JWT with payload `{id}` and the user's public profile (no password)

#### Scenario: Inactive user rejected

- GIVEN a user with is_active=false and valid credentials
- WHEN they log in
- THEN the request MUST fail with 401 Unauthorized

### Requirement: Role-Based Authorization

Protected endpoints MUST declare the required `user_role` values and be enforced by a guard reading the authenticated user's single `role`. Patients MUST NOT access office/admin endpoints.

#### Scenario: Guard enforces role

- GIVEN an endpoint protected for roles 'office','admin'
- WHEN a patient-role user calls it with a valid JWT
- THEN the request MUST fail with 403 Forbidden

#### Scenario: Missing or invalid token rejected

- GIVEN any protected endpoint
- WHEN the request carries no token or an invalid one
- THEN the request MUST fail with 401 Unauthorized
