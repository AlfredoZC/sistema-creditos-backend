# Mapeo ES → EN del Esquema de Base de Datos

Documento de referencia para la traducción del esquema original en español al esquema final en inglés de la plataforma de créditos. La fuente de verdad es el esquema final implementado en las migraciones `1786000000001-AuthSingleRole.ts` y `1786000000002-CoreModules.ts`, con la migración base `1785621997266-Init.ts` como origen de las tablas preexistentes `users` y `profiles`.

**Convenciones de la traducción**

- Nombres de tablas y columnas finales en inglés, `snake_case`.
- El dinero se modela como `NUMERIC(10,2)` (nunca como float de JS).
- Los valores de negocio que en el esquema ES eran `VARCHAR` + `CHECK` pasaron a tipos `ENUM` de PostgreSQL (ver sección de valores de enumeración).
- Todas las claves foráneas usan `ON DELETE NO ACTION / ON UPDATE NO ACTION`.

## Resumen: Tabla ES → Tabla EN

| Tabla ES | Tabla EN | Estado |
|---|---|---|
| usuario | users | Implementada (modificada por la migración 001) |
| paciente | patients | Implementada (migración 002) |
| medico | doctors | Implementada (migración 002) |
| catalogo_cirugia | surgery_catalog | Implementada (migración 002) |
| cirugia | surgeries | Implementada (migración 002) |
| cirugia_medica | surgery_doctors | Implementada (migración 002) |
| plan_pago | payment_plans | Implementada (migración 002) |
| cuota | installments | Implementada (migración 002) |
| metodo_pago | payment_methods | Implementada (migración 002) |
| pago | payments | Implementada (migración 002) |
| auditoria | audit_logs | Implementada (migración 002) |
| plantilla_mensaje | message_templates | Pendiente (siguiente fase: bot de WhatsApp) |
| envio_whatsapp | whatsapp_dispatches | Pendiente (siguiente fase: bot de WhatsApp) |
| conversacion_bot | bot_conversations | Pendiente (siguiente fase: bot de WhatsApp) |
| mensaje_bot | bot_messages | Pendiente (siguiente fase: bot de WhatsApp) |

## usuario → users

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| usuario | users |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| usuario_id | id | [PK] Mismo propósito; `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| email | email | Tipo ajustado de `TEXT` a `VARCHAR(255)`; UNIQUE. |
| password | password | Tipo ajustado de `TEXT` a `VARCHAR(255)`; almacena hash bcrypt. |
| nombre | name | Tipo ajustado de `TEXT` a `VARCHAR(50)`. |
| roles | role | Cambio estructural: el arreglo `roles text[]` del código legado (y el `VARCHAR(20) + CHECK` de la guía ES) se reemplaza por UNA sola columna `role` de tipo enum `user_role`, `NOT NULL`. |
| esta_activo | is_active | Renombrada desde el legado `isActive` (camelCase) a `is_active`; `BOOLEAN NOT NULL DEFAULT true`. |
| — (no existía) | profileId | [FK → profiles.id] Columna preexistente del scaffold (migración Init), conservada; UNIQUE; NULL = perfil opcional. |

**Notas**

- `lastName` (columna del legado Init, ausente en la guía ES) se ELIMINÓ en la migración 001. El esquema final no tiene apellidos en `users`; los apellidos viven en `patients` (`first_name`, `paternal_last_name`, `maternal_last_name`).
- Migración de datos de `roles[1]` → `role` (migración 001): `'admin'` → `'admin'`, `'super-user'` → `'admin'` (privilegio preservado), cualquier otro valor (incluido el legado `'user'`) → `'patient'`.
- La migración 001 documenta su reversión: restaura `roles text[]` y `lastName text NOT NULL DEFAULT ''`.

## paciente → patients

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| paciente | patients |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| paciente_id | id | [PK] `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| usuario_id | user_id | [FK → users.id] NULL = paciente sin cuenta web (modelo híbrido); UNIQUE. |
| documento_identidad | identity_document | `VARCHAR(20)` NOT NULL; UNIQUE (segunda verificación del bot). |
| nombre | first_name | `VARCHAR(50)` NOT NULL. El nombre completo ES se descompone en tres columnas. |
| paterno | paternal_last_name | `VARCHAR(50)` NOT NULL. |
| materno | maternal_last_name | `VARCHAR(50)` NULL. |
| fecha_nacimiento | birth_date | `DATE` NULL. |
| direccion | address | `VARCHAR(100)` NULL. |
| telefono | phone | `VARCHAR(50)` NOT NULL; UNIQUE (identidad en WhatsApp). |

## medico → doctors

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| medico | doctors |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| medico_id | id | [PK] `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| usuario_id | user_id | [FK → users.id] NOT NULL; UNIQUE (cuenta obligatoria: el panel médico es su herramienta de trabajo). |
| especialidad | specialty | `TEXT` NOT NULL. |
| matricula_profesional | professional_license | `TEXT` NOT NULL; UNIQUE. |

## catalogo_cirugia → surgery_catalog

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| catalogo_cirugia | surgery_catalog |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| catalogo_cirugia_id | id | [PK] `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| nombre | name | `VARCHAR(50)` NOT NULL; SIN constraint UNIQUE (igual que la guía ES). |
| descripcion | description | `TEXT` NULL. |
| costo_base | base_cost | `NUMERIC(10,2)` NOT NULL; CHECK `base_cost >= 0` (`chk_surgery_catalog_base_cost_non_negative`). |

## cirugia → surgeries

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| cirugia | surgeries |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| cirugia_id | id | [PK] `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| paciente_id | patient_id | [FK → patients.id] NOT NULL. |
| catalogo_cirugia_id | surgery_catalog_id | [FK → surgery_catalog.id] NOT NULL. |
| fecha_programada | scheduled_date | `DATE` NOT NULL. |
| costo_total | total_cost | `NUMERIC(10,2)` NOT NULL; CHECK `total_cost >= 0` (`chk_surgeries_total_cost_non_negative`). |
| estado | status | `VARCHAR(20) + CHECK` → enum `surgery_status`; NOT NULL, `DEFAULT 'scheduled'`. |
| observaciones | notes | `TEXT` NULL. |

## cirugia_medica → surgery_doctors

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| cirugia_medica | surgery_doctors |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| cirugia_medica_id | id | [PK] `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| cirugia_id | surgery_id | [FK → surgeries.id] NOT NULL. |
| medico_id | doctor_id | [FK → doctors.id] NOT NULL. |
| rol | role | `VARCHAR(20) + CHECK` → enum `surgery_doctor_role`; NOT NULL, `DEFAULT 'principal'`. |

**Notas**

- UNIQUE `(surgery_id, doctor_id)` (`uq_surgery_doctors_surgery_doctor`): el mismo médico no puede participar dos veces en la misma cirugía.
- Índice parcial único `uq_un_principal_por_cirugia` → `uq_one_principal_per_surgery`: una cirugía puede tener UN solo cirujano principal (aplica solo a filas con `role = 'principal'`).

## plan_pago → payment_plans

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| plan_pago | payment_plans |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| plan_pago_id | id | [PK] `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| cirugia_id | surgery_id | [FK → surgeries.id] NOT NULL; UNIQUE (un solo plan por cirugía). |
| tipo_plan | type | `VARCHAR(10) + CHECK` → enum `payment_plan_type` (`contado`/`credito` → `upfront`/`credit`); NOT NULL. |
| cuota_inicial | down_payment | `NUMERIC(10,2)` NOT NULL, `DEFAULT '0.00'`; CHECK `>= 0`. |
| monto_financiado | financed_amount | `NUMERIC(10,2)` NOT NULL; CHECK `>= 0`. |
| tasa_interes_mensual | monthly_interest_rate | `NUMERIC(10,2)` NOT NULL, `DEFAULT '2.00'`. |
| numero_cuotas | installment_count | `INTEGER` NOT NULL; CHECK `> 0`. |
| fecha_inicio | start_date | `DATE` NOT NULL. |
| saldo_pendiente | outstanding_balance | `NUMERIC(10,2)` NOT NULL; CHECK `>= 0`; rastrea solo el capital vivo. |
| estado | status | `VARCHAR(20) + CHECK` → enum `payment_plan_status`; NOT NULL, `DEFAULT 'active'`. |

## cuota → installments

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| cuota | installments |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| cuota_id | id | [PK] `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| plan_pago_id | payment_plan_id | [FK → payment_plans.id] NOT NULL. |
| numero_cuota | installment_number | `INTEGER` NOT NULL; UNIQUE `(payment_plan_id, installment_number)`. |
| monto_capital | principal_amount | `NUMERIC(10,2)` NOT NULL; CHECK `>= 0`. |
| monto_interes | interest_amount | `NUMERIC(10,2)` NOT NULL, `DEFAULT '0.00'`; CHECK `>= 0`. |
| monto_total | total_amount | `NUMERIC(10,2)` NOT NULL; CHECK `> 0`. |
| monto_pagado | paid_amount | `NUMERIC(10,2)` NOT NULL, `DEFAULT '0.00'`; CHECK `0 <= paid_amount <= total_amount` (acumulador de abonos parciales). |
| fecha_vencimiento | due_date | `DATE` NOT NULL. |
| estado | status | `VARCHAR(15) + CHECK` → enum `installment_status`; NOT NULL, `DEFAULT 'pending'`. Se AGREGA el valor `cancelled` (no existía en ES) para cuotas sobrantes en recálculos. |

## metodo_pago → payment_methods

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| metodo_pago | payment_methods |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| metodo_pago_id | id | [PK] `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| metodo | name | `VARCHAR(50)` NOT NULL; UNIQUE. |
| esta_habilitado | is_enabled | `BOOLEAN` NOT NULL, `DEFAULT true`. |
| descripcion | description | `TEXT` NULL. |

**Datos semilla** (migración 002): `efectivo` → `cash`, `transferencia` → `bank_transfer`, `QR` → `qr`, `tarjeta` → `card`.

## pago → payments

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| pago | payments |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| pago_id | id | [PK] `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| plan_pago_id | payment_plan_id | [FK → payment_plans.id] NOT NULL. |
| cuota_id | installment_id | [FK → installments.id] NULL; obligatoriamente NULL cuando `type = principal_amortization` (CHECK). |
| paciente_usuario_id | patient_user_id | [FK → users.id] NULL = paciente sin cuenta web. |
| oficina_usuario_id | recorded_by_user_id | [FK → users.id] NOT NULL; usuario que registró el cobro. |
| metodo_pago_id | payment_method_id | [FK → payment_methods.id] NOT NULL. |
| monto | amount | `NUMERIC(10,2)` NOT NULL; CHECK `> 0`. |
| tipo | type | `VARCHAR(25) + CHECK` → enum `payment_type`. |
| modalidad_amortizacion | amortization_mode | `VARCHAR(20) + CHECK` → enum `amortization_mode`; NULL salvo que `type = principal_amortization` (CHECK XOR). |
| fecha_pago | paid_at | `TIMESTAMPTZ` NOT NULL, `DEFAULT now()`. |
| comprobante_url | receipt_url | `TEXT` NULL. |
| estado | status | `VARCHAR(25) + CHECK` → enum `payment_status`; NOT NULL, `DEFAULT 'pending_confirmation'`. |

## auditoria → audit_logs

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| auditoria | audit_logs |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| auditoria_id | id | [PK] `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| usuario_id | user_id | [FK → users.id] NULL = acción del sistema (cron/jobs). |
| accion | action | `TEXT` NOT NULL. |
| tabla_afectada | table_name | `TEXT` NOT NULL. |
| registro_id | record_id | `UUID` NULL; polimórfico, SIN FK (apunta a cualquier tabla). |
| datos_anteriores | previous_data | `JSONB` NULL. |
| datos_nuevos | new_data | `JSONB` NULL. |
| fecha | created_at | `TIMESTAMPTZ` NOT NULL, `DEFAULT now()`. |

## Valores de enumeración: Valor ES → Valor EN

### `user_role` (columna `users.role`)

| Valor ES | Valor EN |
|---|---|
| paciente | patient |
| medico | doctor |
| oficina | office |
| admin | admin |

Nota legado: en el modelo `roles[]` previo, `'user'` mapea a `patient` y `'super-user'` mapea a `admin`.

### `surgery_status` (columna `surgeries.status`)

| Valor ES | Valor EN |
|---|---|
| programada | scheduled |
| realizada | performed |
| cancelada | cancelled |

### `surgery_doctor_role` (columna `surgery_doctors.role`)

| Valor ES | Valor EN |
|---|---|
| principal | principal |
| asistente | assistant |
| anestesiologo | anesthesiologist |

### `payment_plan_type` (columna `payment_plans.type`)

| Valor ES | Valor EN |
|---|---|
| contado | upfront |
| credito | credit |

### `payment_plan_status` (columna `payment_plans.status`)

| Valor ES | Valor EN |
|---|---|
| activo | active |
| completado | completed |
| en_mora | delinquent |
| cancelado | cancelled |

### `installment_status` (columna `installments.status`)

| Valor ES | Valor EN |
|---|---|
| pendiente | pending |
| parcial | partial |
| pagada | paid |
| vencida | overdue |
| — (nuevo) | cancelled |

### `payment_type` (columna `payments.type`)

| Valor ES | Valor EN |
|---|---|
| cuota_inicial | down_payment |
| pago_cuota | installment_payment |
| amortizacion_capital | principal_amortization |

### `payment_status` (columna `payments.status`)

| Valor ES | Valor EN |
|---|---|
| pendiente_confirmacion | pending_confirmation |
| confirmado | confirmed |
| rechazado | rejected |

### `amortization_mode` (columna `payments.amortization_mode`)

| Valor ES | Valor EN |
|---|---|
| reducir_cuota | reduce_installment |
| reducir_plazo | reduce_term |

## Tablas de la siguiente fase (bot de WhatsApp)

Las siguientes tablas pertenecen al módulo de bot de WhatsApp, fuera del alcance de la fase actual (módulos de negocio núcleo). Se listan con su nombre EN propuesto; la traducción detallada de columnas se definirá en la siguiente fase.

| Tabla ES | Tabla EN | Estado |
|---|---|---|
| plantilla_mensaje | message_templates | Pendiente (siguiente fase) |
| envio_whatsapp | whatsapp_dispatches | Pendiente (siguiente fase) |
| conversacion_bot | bot_conversations | Pendiente (siguiente fase) |
| mensaje_bot | bot_messages | Pendiente (siguiente fase) |
