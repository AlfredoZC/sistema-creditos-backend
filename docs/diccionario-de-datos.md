# Diccionario de Datos

Diccionario del esquema final de la plataforma de créditos, en español, para equipos técnicos y de negocio. Documenta todas las tablas, columnas, tipos, restricciones y la lógica de financiamiento y amortización.

**Fuente de verdad:** migraciones finales `1786000000001-AuthSingleRole.ts` (001) y `1786000000002-CoreModules.ts` (002), más la migración base `1785621997266-Init.ts` para las tablas preexistentes `users` y `profiles`.

**Convenciones**

- `Requerido` = Sí cuando la columna es `NOT NULL`; No cuando admite NULL.
- `[PK]` = clave primaria; `[FK → tabla.columna]` = clave foránea.
- El dinero se almacena como `NUMERIC(10,2)` y viaja como cadena decimal (nunca como float de JS).
- Los tipos enum de PostgreSQL se indican con su nombre de tipo (p. ej. `user_role`); sus valores se listan en la descripción.
- Todas las claves foráneas usan `ON DELETE NO ACTION / ON UPDATE NO ACTION`.

## Migraciones que definen el esquema

| Migración | Contenido |
|---|---|
| `1785621997266-Init.ts` | Baseline preexistente: crea `profiles` y `users` (con `roles text[]`, `lastName`, `isActive`). |
| `1786000000001-AuthSingleRole.ts` | Refactor de autenticación: crea el tipo `user_role`, agrega `users.role` (con migración de datos `roles[1]` → `role`), elimina `roles` y `lastName`, renombra `isActive` → `is_active`, alinea longitudes `VARCHAR` y el default de `id` a `gen_random_uuid()`. |
| `1786000000002-CoreModules.ts` | Crea los 8 tipos enum restantes y las 10 tablas de negocio (`patients`, `doctors`, `surgery_catalog`, `surgeries`, `surgery_doctors`, `payment_plans`, `installments`, `payment_methods`, `payments`, `audit_logs`) con CHECKs, UNIQUEs, índices (incluido el índice parcial único de un principal por cirugía) y la semilla de `payment_methods`. |

---

## users

Usuarios del sistema (solo autenticación). Tabla preexistente, modificada por la migración 001: rol único, sin `lastName`, `is_active` en snake_case.

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador del usuario. `DEFAULT gen_random_uuid()`. |
| email | VARCHAR(255) | Sí | Correo electrónico. UNIQUE. |
| password | VARCHAR(255) | Sí | Hash bcrypt de la contraseña. |
| name | VARCHAR(50) | Sí | Nombre visible del usuario. |
| role | user_role | Sí | Rol único del usuario. Valores: `patient`, `doctor`, `office`, `admin`. |
| is_active | BOOLEAN | Sí | Indica si la cuenta está activa. `DEFAULT true`. |
| profileId | INTEGER | No | [FK → profiles.id] Perfil opcional (preexistente del scaffold). UNIQUE. |

## profiles

Perfiles complementarios de usuario (preexistente del scaffold; no modificada por 001/002).

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | SERIAL | Sí | [PK] Identificador del perfil. |
| gender | TEXT | Sí | Género declarado. `DEFAULT 'No especificado'`. |
| photo | TEXT | Sí | URL de la foto. `DEFAULT ''`. |
| photoPublicId | TEXT | Sí | Identificador público de la foto en el proveedor de almacenamiento. `DEFAULT ''`. |

## patients

Pacientes. `user_id` NULL = paciente sin cuenta web (modelo híbrido, identificado por teléfono).

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador del paciente. `DEFAULT gen_random_uuid()`. |
| user_id | UUID | No | [FK → users.id] Cuenta de usuario opcional. UNIQUE (un paciente por cuenta). |
| identity_document | VARCHAR(20) | Sí | Documento de identidad. UNIQUE. Segunda verificación del bot. |
| first_name | VARCHAR(50) | Sí | Primer nombre. |
| paternal_last_name | VARCHAR(50) | Sí | Apellido paterno. |
| maternal_last_name | VARCHAR(50) | No | Apellido materno (opcional). |
| birth_date | DATE | No | Fecha de nacimiento. |
| address | VARCHAR(100) | No | Dirección. |
| phone | VARCHAR(50) | Sí | Teléfono. UNIQUE. Identidad en WhatsApp. |

## doctors

Médicos. La cuenta de usuario es obligatoria (panel médico).

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador del médico. `DEFAULT gen_random_uuid()`. |
| user_id | UUID | Sí | [FK → users.id] Cuenta de usuario del médico (rol `doctor`). UNIQUE. |
| specialty | TEXT | Sí | Especialidad. |
| professional_license | TEXT | Sí | Matrícula profesional. UNIQUE. |

## surgery_catalog

Catálogo de cirugías (costo base para nuevas cirugías).

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador del ítem de catálogo. `DEFAULT gen_random_uuid()`. |
| name | VARCHAR(50) | Sí | Nombre de la cirugía. Sin constraint UNIQUE. |
| description | TEXT | No | Descripción. |
| base_cost | NUMERIC(10,2) | Sí | Costo base. CHECK `base_cost >= 0` (`chk_surgery_catalog_base_cost_non_negative`). |

## surgeries

Cirugías programadas. El costo total por defecto toma el `base_cost` del catálogo.

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador de la cirugía. `DEFAULT gen_random_uuid()`. |
| patient_id | UUID | Sí | [FK → patients.id] Paciente. |
| surgery_catalog_id | UUID | Sí | [FK → surgery_catalog.id] Ítem del catálogo. |
| scheduled_date | DATE | Sí | Fecha programada. |
| total_cost | NUMERIC(10,2) | Sí | Costo total de la cirugía. CHECK `total_cost >= 0` (`chk_surgeries_total_cost_non_negative`). |
| status | surgery_status | Sí | Estado. Valores: `scheduled`, `performed`, `cancelled`. `DEFAULT 'scheduled'`. |
| notes | TEXT | No | Observaciones. |

## surgery_doctors

Participación de médicos en cirugías (N:M). UNIQUE `(surgery_id, doctor_id)`: el mismo médico no puede participar dos veces en la misma cirugía. Índice parcial único `uq_one_principal_per_surgery`: una cirugía tiene UN solo cirujano principal.

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador de la participación. `DEFAULT gen_random_uuid()`. |
| surgery_id | UUID | Sí | [FK → surgeries.id] Cirugía. |
| doctor_id | UUID | Sí | [FK → doctors.id] Médico. |
| role | surgery_doctor_role | Sí | Rol del médico en la cirugía. Valores: `principal`, `assistant`, `anesthesiologist`. `DEFAULT 'principal'`. |

## payment_plans

Planes de pago. UNIQUE `surgery_id`: un solo plan por cirugía. `financed_amount = total_cost − down_payment`; el cronograma se genera sobre el monto financiado.

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador del plan. `DEFAULT gen_random_uuid()`. |
| surgery_id | UUID | Sí | [FK → surgeries.id] Cirugía asociada. UNIQUE. |
| type | payment_plan_type | Sí | Tipo de plan. Valores: `upfront` (contado, 1 cuota sin interés), `credit` (crédito con interés). |
| down_payment | NUMERIC(10,2) | Sí | Cuota inicial (anticipo). `DEFAULT '0.00'`. CHECK `>= 0`. |
| financed_amount | NUMERIC(10,2) | Sí | Monto financiado (base del cronograma). CHECK `>= 0`. |
| monthly_interest_rate | NUMERIC(10,2) | Sí | Tasa de interés mensual (%). `DEFAULT '2.00'`. |
| installment_count | INTEGER | Sí | Número de cuotas. CHECK `> 0`. |
| start_date | DATE | Sí | Fecha de inicio del cronograma. |
| outstanding_balance | NUMERIC(10,2) | Sí | Saldo pendiente: solo capital vivo, nunca negativo. CHECK `>= 0`. |
| status | payment_plan_status | Sí | Estado del plan. Valores: `active`, `completed`, `delinquent`, `cancelled`. `DEFAULT 'active'`. |

## installments

Cuotas del cronograma de un plan (sistema de amortización francés). `paid_amount` es acumulador de abonos parciales.

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador de la cuota. `DEFAULT gen_random_uuid()`. |
| payment_plan_id | UUID | Sí | [FK → payment_plans.id] Plan al que pertenece. |
| installment_number | INTEGER | Sí | Número de cuota dentro del plan. UNIQUE `(payment_plan_id, installment_number)`. |
| principal_amount | NUMERIC(10,2) | Sí | Monto de capital de la cuota. CHECK `>= 0`. |
| interest_amount | NUMERIC(10,2) | Sí | Monto de interés (sobre saldo insoluto). `DEFAULT '0.00'`. CHECK `>= 0`. |
| total_amount | NUMERIC(10,2) | Sí | Monto total de la cuota. CHECK `> 0`. |
| paid_amount | NUMERIC(10,2) | Sí | Monto pagado acumulado. `DEFAULT '0.00'`. CHECK `0 <= paid_amount <= total_amount` (`chk_installments_paid_amount_within_total`). |
| due_date | DATE | Sí | Fecha de vencimiento. |
| status | installment_status | Sí | Estado. Valores: `pending`, `partial`, `paid`, `overdue`, `cancelled`. `DEFAULT 'pending'`. `cancelled` marca cuotas sobrantes en recálculos (filas conservadas, nunca eliminadas). |

## payment_methods

Catálogo de métodos de pago. `GET /api/payment-methods` expone solo los habilitados.

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador del método. `DEFAULT gen_random_uuid()`. |
| name | VARCHAR(50) | Sí | Nombre del método. UNIQUE. |
| is_enabled | BOOLEAN | Sí | Habilita/deshabilita el método. `DEFAULT true`. |
| description | TEXT | No | Descripción. |

Datos semilla (migración 002): `cash`, `bank_transfer`, `qr`, `card`, todos habilitados.

## payments

Pagos registrados. Reglas de integridad: `amount > 0`; la amortización a capital nunca lleva `installment_id`; un pago de cuota siempre lo referencia; `amortization_mode` solo existe cuando `type = principal_amortization` (CHECKs `chk_payments_amount_positive`, `chk_payments_amortization_has_no_installment`, `chk_payments_installment_payment_has_installment`, `chk_payments_amortization_mode_xor`).

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador del pago. `DEFAULT gen_random_uuid()`. |
| payment_plan_id | UUID | Sí | [FK → payment_plans.id] Plan al que aplica. |
| installment_id | UUID | No | [FK → installments.id] Cuota asociada; NULL cuando `type = principal_amortization`. |
| patient_user_id | UUID | No | [FK → users.id] Paciente que paga; NULL = paciente sin cuenta web. |
| recorded_by_user_id | UUID | Sí | [FK → users.id] Usuario que registró el cobro (oficina/admin). |
| payment_method_id | UUID | Sí | [FK → payment_methods.id] Método de pago (debe estar habilitado). |
| amount | NUMERIC(10,2) | Sí | Monto del pago. CHECK `> 0`. |
| type | payment_type | Sí | Tipo. Valores: `down_payment`, `installment_payment`, `principal_amortization`. |
| amortization_mode | amortization_mode | No | Modalidad de recálculo. Valores: `reduce_installment`, `reduce_term`. Solo permitido con `type = principal_amortization` (CHECK XOR). |
| paid_at | TIMESTAMPTZ | Sí | Fecha y hora del pago. `DEFAULT now()`. |
| receipt_url | TEXT | No | URL del comprobante (subida del paciente). |
| status | payment_status | Sí | Estado. Valores: `pending_confirmation`, `confirmed`, `rejected`. `DEFAULT 'pending_confirmation'`. |

## audit_logs

Bitácora de auditoría, de solo escritura (append-only). `record_id` es polimórfico (sin FK): apunta a cualquier tabla. `user_id` NULL = acción del sistema. Vocabulario de acciones: `payment_plan.created`, `payment.confirmed`, `payment.rejected`, `payment_plan.recalculated`, `surgery.status_changed`.

| Elemento | Tipo de Dato | Requerido | Descripción |
|---|---|---|---|
| id | UUID | Sí | [PK] Identificador del registro de auditoría. `DEFAULT gen_random_uuid()`. |
| user_id | UUID | No | [FK → users.id] Actor de la acción; NULL = acción del sistema. |
| action | TEXT | Sí | Acción realizada (vocabulario de acciones de negocio). |
| table_name | TEXT | Sí | Tabla afectada. |
| record_id | UUID | No | Identificador del registro afectado (polimórfico, sin FK). |
| previous_data | JSONB | No | Estado previo del registro (cuando aplica). |
| new_data | JSONB | No | Estado nuevo del registro (cuando aplica). |
| created_at | TIMESTAMPTZ | Sí | Fecha y hora del registro. `DEFAULT now()`. |

---

## Índices

| Índice | Tabla | Columnas | Tipo |
|---|---|---|---|
| idx_surgeries_patient_id | surgeries | patient_id | B-tree |
| idx_surgery_doctors_surgery_id | surgery_doctors | surgery_id | B-tree |
| idx_surgery_doctors_doctor_id | surgery_doctors | doctor_id | B-tree |
| uq_one_principal_per_surgery | surgery_doctors | surgery_id WHERE role = 'principal' | UNIQUE parcial |
| idx_installments_payment_plan_id | installments | payment_plan_id | B-tree |
| idx_installments_due_date_status | installments | due_date, status | B-tree |
| idx_payments_payment_plan_id | payments | payment_plan_id | B-tree |
| idx_payments_installment_id | payments | installment_id | B-tree |
| idx_payments_recorded_by_user_id | payments | recorded_by_user_id | B-tree |
| idx_audit_logs_user_id | audit_logs | user_id | B-tree |
| idx_audit_logs_created_at | audit_logs | created_at | B-tree |

---

## Anexo: Lógica de financiamiento y amortización (sistema francés)

El cronograma usa el sistema de amortización francés (cuota fija):

```
Cuota = P × i / (1 − (1 + i)^−n)
```

Donde P = capital financiado, i = tasa de interés mensual, n = número de cuotas. El interés se calcula sobre el saldo insoluto (capital aún debido). Cada línea se redondea HALF_UP a 2 decimales y la ÚLTIMA cuota absorbe el remanente del redondeo, de modo que el cronograma suma exacto. Para `i = 0`, la cuota es `P / n` sin interés.

**Ejemplo fijo de referencia (P = 10.000,00; i = 2% mensual; n = 10 → cuota 1.113,27):**

| # Cuota | Capital | Interés | Total |
| :---: | :--- | :--- | :--- |
| 1 | 913,27 | 200,00 | 1.113,27 |
| 2 | 931,54 | 181,73 | 1.113,27 |
| 3 | 950,17 | 163,10 | 1.113,27 |
| 4 | 969,17 | 144,10 | 1.113,27 |
| 5 | 988,55 | 124,72 | 1.113,27 |
| 6 | 1.008,32 | 104,95 | 1.113,27 |
| 7 | 1.028,49 | 84,78 | 1.113,27 |
| 8 | 1.049,06 | 64,21 | 1.113,27 |
| 9 | 1.070,04 | 43,23 | 1.113,27 |
| 10 | 1.091,39 | 21,83 | 1.113,22 |

**Totales:** capital 10.000,00 + interés 1.132,65 = **11.132,65**. La última cuota (1.113,22) absorbe el remanente del redondeo.

**Cuota inicial (anticipo):** con `down_payment > 0`, el cronograma se genera sobre `financed_amount = total_cost − down_payment`. Ejemplo: cirugía de 10.000,00 con 3.000,00 de inicial → plan `credit` por 7.000,00; el cronograma se calcula sobre los 7.000,00 financiados. Los planes `upfront` (contado) tienen `installment_count = 1` y una sola línea sin interés.

**Clamping de fin de mes:** la fecha de vencimiento de la cuota k es `start_date + k` meses calendario; el desbordamiento de día se ajusta al último día del mes objetivo. Ejemplo: inicio 2026-01-31 → cuota 1 vence 2026-02-28 y cuota 3 vence 2026-04-30.

**Amortización de capital (pago extraordinario):** un pago `principal_amortization` descuenta su monto completo de `outstanding_balance` y, al confirmarse, dispara el recálculo de las cuotas pendientes dentro de la misma transacción (con `SELECT FOR UPDATE` sobre el plan). Solo las cuotas pendientes se recalculan en sitio (IDs estables, nunca se eliminan); las parciales/pagadas no se tocan.

- **Opción A — `reduce_installment` (mantener plazo):** se recalcula una cuota menor sobre el nuevo saldo y el plazo restante. Ejemplo fijo: saldo 5.155,19, i = 2%, n = 8 → cuota 703,73; cuotas 1–7 a 703,73 y la cuota 8 absorbe el remanente con 703,76. Total: 5.629,87. *(Nota: la propuesta de negocio original citaba 703,74; el algoritmo exacto produce 703,73/703,76 — diferencia de un centavo aceptada y verificada.)*
- **Opción B — `reduce_term` (mantener cuota):** se mantiene la cuota de 1.113,27 y se reduce el número de cuotas; una cuota final fraccionaria liquida el saldo y las cuotas sobrantes pasan a `cancelled` (filas conservadas). Ejemplo fijo: 4 cuotas de 1.113,27 + cuota final de 1.011,50 (capital 991,67 + interés 19,83); 3 cuotas sobrantes canceladas.

**Ciclo de vida del plan:** `completed` ⇔ todas las cuotas no canceladas están pagadas y `outstanding_balance = 0`; `delinquent` ⇔ alguna cuota no cancelada está vencida (vuelve a `active` cuando no queda ninguna); en otro caso `active`. Las cuotas `cancelled` no cuentan para completado ni mora.
