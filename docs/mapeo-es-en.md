# Mapeo ES → EN del Esquema de Base de Datos

Documento de referencia para la traducción del esquema original en español al esquema final en inglés de la plataforma de créditos. La fuente de verdad es el esquema final implementado en las migraciones `1786000000001-AuthSingleRole.ts`, `1786000000002-CoreModules.ts` y `1786000000003-WhatsAppBot.ts`, con la migración base `1785621997266-Init.ts` como origen de las tablas preexistentes `users` y `profiles`.

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
| plantilla_mensaje | message_templates | Implementada (migración 003) |
| envio_whatsapp | whatsapp_dispatches | Implementada (migración 003) |
| conversacion_bot | bot_conversations | Implementada (migración 003) |
| mensaje_bot | bot_messages | Implementada (migración 003) |

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

## plantilla_mensaje → message_templates

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| plantilla_mensaje | message_templates |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| plantilla_mensaje_id | id | [PK] Mismo propósito; `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| nombre | name | `VARCHAR(100) NOT NULL` (ampliado de `VARCHAR(50)`); UNIQUE `(name, language)` — par de identidad en Meta. |
| tipo | category | Cambio estructural: el `VARCHAR(30) + CHECK` con casos de uso ES (`recordatorio_3_dias`, `recordatorio_vencimiento`, `aviso_mora`, `bienvenida`, `confirmacion_pago`) se reemplaza por el enum `template_category` (`utility`/`marketing`/`authentication`) — categoría de Meta (ver valores). |
| contenido | body_template | `TEXT` NOT NULL; placeholders contiguos `{{1}}…{{N}}`; CHECK no vacío (`chk_message_templates_body_non_empty`). |
| — (no existía) | language | `VARCHAR(10)` NOT NULL, `DEFAULT 'es'` — código de idioma de Meta. |
| — (no existía) | sample_variables | `JSONB` NOT NULL, `DEFAULT '{}'::jsonb` — contenido de ejemplo para Meta. |
| — (no existía) | status | enum `template_status` NOT NULL, `DEFAULT 'draft'` — ciclo de vida con Meta (nuevo). |
| — (no existía) | provider_template_id | `VARCHAR(255)` NULL — ID de la plantilla en Meta tras el submit. |
| — (no existía) | provider_status | `VARCHAR(50)` NULL — espejo del estado crudo de Meta (p. ej. `IN_APPROVAL`, `APPROVED`). |
| — (no existía) | is_active | `BOOLEAN` NOT NULL, `DEFAULT true`; la desactivación bloquea nuevos despachos sin borrar la fila. |
| — (no existía) | created_by_user_id | [FK → users.id] NULL = sistema. |
| — (no existía) | created_at / updated_at | `TIMESTAMPTZ` NOT NULL, `DEFAULT now()`. |

**Notas**

- La tabla ES no tenía estado de plantilla ni contador de aprobación de Meta; el ciclo `draft → submitted → approved|rejected|paused` es nuevo (ver valores de `template_status`).

## envio_whatsapp → whatsapp_dispatches

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| envio_whatsapp | whatsapp_dispatches |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| envio_whatsapp_id | id | [PK] Mismo propósito; `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| paciente_id | patient_id | [FK → patients.id] NOT NULL. |
| cuota_id | — (eliminada) | La referencia directa a una cuota se elimina: el despacho apunta a `template_id` y a las variables resueltas. |
| plantilla_id | template_id | [FK → message_templates.id] NOT NULL. |
| mensaje_final | payload | Cambio de semántica: el texto final renderizado ya NO se almacena; EN guarda SOLO las variables resueltas (`JSONB`, no-PII). |
| variables | payload | Fusionada con `mensaje_final`: `payload` conserva las variables resueltas tal como se enviaron (`JSONB`, no-PII). |
| whatsapp_message_id | provider_message_id | `VARCHAR(255)` NULL; UNIQUE (wamid; dedupe de statuses del webhook). |
| estado | status | `VARCHAR(20) + CHECK` → enum `dispatch_status`; NOT NULL, `DEFAULT 'queued'`. Se AGREGA `queued` (no existía en ES); `enviado` → `sent`. |
| fecha_envio | sent_at | `TIMESTAMPTZ` NULL; se completa al enviar efectivamente. |
| — (no existía) | send_attempts | `SMALLINT` NOT NULL, `DEFAULT 0`; CHECK `0..3` — nueva columna técnica (máximo 3 intentos de envío). |
| — (no existía) | provider_error | `TEXT` NULL — detalle del fallo del proveedor; nunca se espeja en auditoría. |
| — (no existía) | phone | `VARCHAR(50)` NOT NULL — instantánea canónica del teléfono al momento del despacho. |
| — (no existía) | dedupe_key | `TEXT` NULL; UNIQUE — nueva columna técnica (D1): `sha256(patient_id ‖ template_id ‖ created_by_user_id ‖ variables canónicas)`; despacho duplicado idéntico → 409. |
| — (no existía) | created_by_user_id | [FK → users.id] NULL = sistema. |
| — (no existía) | created_at / updated_at | `TIMESTAMPTZ` NOT NULL, `DEFAULT now()`. |

**Notas**

- `payload` (no-PII) y `phone` (instantánea) se fijan en la transacción de creación; la plantilla aprobada + activa es condición para despachar (gate del servicio).

## conversacion_bot → bot_conversations

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| conversacion_bot | bot_conversations |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| conversacion_bot_id | id | [PK] Mismo propósito; `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| paciente_id | patient_id | Cambio de cardinalidad: [FK → patients.id] NOT NULL en ES; NULL en EN hasta que la conversación se identifica (CHECK `state_matches_patient`). |
| telefono | wa_id | `VARCHAR(50)` NOT NULL; UNIQUE — una sola conversación por número (identidad WhatsApp normalizada). |
| estado_conversacion | state | `VARCHAR(30) + CHECK` → enum `bot_conversation_state`; NOT NULL, `DEFAULT 'unidentified'`; máquina de estados rediseñada (ver valores). |
| ultima_interaccion | last_activity_at | `TIMESTAMPTZ` NOT NULL, `DEFAULT now()`; define la ventana CSW de 24h. |
| activa | — (eliminada) | La flag `activa` desaparece: el ciclo de vida se modela con `state` + `ended_at` (NULL hasta un cierre explícito). |
| — (no existía) | failed_attempts | `SMALLINT` NOT NULL, `DEFAULT 0`; CHECK `0..3` — nueva columna técnica (intentos fallidos de identificación). |
| — (no existía) | lockout_until | `TIMESTAMPTZ` NULL — bloqueo suave de 24h tras 3 fallos; NULL = sin bloqueo (nueva columna técnica). |
| — (no existía) | started_at | `TIMESTAMPTZ` NOT NULL, `DEFAULT now()`. |
| — (no existía) | ended_at | `TIMESTAMPTZ` NULL; NULL hasta que exista una funcionalidad de cierre explícito. |

## mensaje_bot → bot_messages

### Tabla ES → Tabla EN

| Tabla ES | Tabla EN |
|---|---|
| mensaje_bot | bot_messages |

### Columna ES → Columna EN

| Columna ES | Columna EN | Notas |
|---|---|---|
| mensaje_bot_id | id | [PK] Mismo propósito; `UUID NOT NULL DEFAULT gen_random_uuid()`. |
| conversacion_id | conversation_id | [FK → bot_conversations.id] NOT NULL. |
| direccion | direction | `VARCHAR(10) + CHECK` → enum `bot_direction`; NOT NULL. `entrante` → `inbound`, `saliente` → `outbound`. |
| tipo_mensaje | type | `VARCHAR(20) + CHECK` (texto/imagen/audio/documento) → `VARCHAR(10)` NOT NULL, `DEFAULT 'text'`, CHECK `type IN ('text','template')`: sin soporte de media en esta fase (no es enum PG: la lista de 5 tipos es fija). |
| contenido | body | `TEXT` NOT NULL (en ES NULL; EN obligatorio: texto del mensaje entrante o de la respuesta). |
| intent_detectado | intent | `VARCHAR(20)` NULL; CHECK `intent IN ('saldo','cuotas','proxima')` — vocabulario nuevo (el ES era `consulta_deuda`, `consulta_proxima_cuota`, `hablar_con_humano`, `envio_comprobante`). |
| payload_raw | metadata | El JSONB crudo del webhook se reemplaza por `metadata` con contenido operacional (`{ status: 'sent'|'failed', error }`); `JSONB` NOT NULL, `DEFAULT '{}'::jsonb`. |
| media_url | — (eliminada) | Sin soporte de media en esta fase. |
| timestamp | created_at | `TIMESTAMPTZ` NOT NULL, `DEFAULT now()`; tabla append-only. |
| — (no existía) | provider_message_id | `VARCHAR(255)` NULL; UNIQUE — dedupe de entregas duplicadas (wamid) (nueva columna técnica). |
| — (no existía) | template_id | [FK → message_templates.id] NULL; se fija en envíos de plantilla (CHECK `template_requires_template_type`). |

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

### `dispatch_status` (columna `whatsapp_dispatches.status`)

| Valor ES | Valor EN |
|---|---|
| enviado | sent |
| entregado | delivered |
| leido | read |
| fallido | failed |
| — (nuevo) | queued |

Nota: el CHECK ES `('enviado','entregado','leido','fallido')` se convierte en enum con el valor adicional `queued` (en cola antes del envío), que pasa a ser el `DEFAULT`.

### `bot_direction` (columna `bot_messages.direction`)

| Valor ES | Valor EN |
|---|---|
| entrante | inbound |
| saliente | outbound |

### `bot_conversation_state` (columna `bot_conversations.state`)

| Valor ES | Valor EN |
|---|---|
| — (nuevo) | unidentified |
| — (nuevo) | awaiting_document |
| — (nuevo) | identified |

Nota: la máquina de estados se rediseñó. El CHECK ES modelaba navegación por menú (`inicio`, `menu_principal`, `consultando_deuda`, `consultando_cuotas`, `esperando_comprobante`); el enum EN modela el ciclo de identificación por teléfono/documento, con bloqueo suave de 24h tras 3 fallos.

### `template_category` (columna `message_templates.category`)

| Valor ES | Valor EN |
|---|---|
| recordatorio_3_dias | utility |
| recordatorio_vencimiento | utility |
| aviso_mora | utility |
| bienvenida | utility |
| confirmacion_pago | utility |
| — (nuevo) | marketing |
| — (nuevo) | authentication |

Nota: el `tipo` ES etiquetaba casos de uso (`recordatorio_3_dias`, …) mediante CHECK; la categoría EN sigue la taxonomía de Meta (`utility`/`marketing`/`authentication`) y se asigna al crear la plantilla. El mapeo de casos de uso ES → categoría EN es indicativo: el diseño solo fuerza `utility` para plantillas de recordatorio al despachar.

### `template_status` (columna `message_templates.status`)

| Valor ES | Valor EN |
|---|---|
| — (nuevo) | draft |
| — (nuevo) | submitted |
| — (nuevo) | approved |
| — (nuevo) | rejected |
| — (nuevo) | paused |

Nota: la tabla ES no tenía estado de plantilla; el ciclo de vida con Meta (borrador → enviada → aprobada/rechazada/pausada) es nuevo.

## Formato canónico de teléfono (WhatsApp)

La identidad del paciente en WhatsApp se apoya en `patients.phone`. El formato canónico para móviles es `+591XXXXXXXX` (12 caracteres: código de país 591 + 8 dígitos).

**Heurística determinista** (compartida entre `src/whatsapp/phone-normalizer.ts` y la copia autocontenida dentro de la migración 003):

1. Se eliminan los separadores conservando un único `+` inicial (`+591 7000-0001` → `+59170000001`).
2. 8 dígitos que empiezan con 6 o 7 → `+591` + dígitos (`70000001` → `+59170000001`).
3. `591` + 8 dígitos → `+` + dígitos (`59170000001` → `+59170000001`).
4. Ya canónico (`+591` + 8 dígitos) → sin cambios.
5. Cualquier otro caso → forma sin separadores tal como se ingresó (nunca se adivina).

**Excepciones "as-provided"** (la heurística no aplica y el valor se conserva como se ingresó): teléfonos fijos (`24000000`), extranjeros (`+541123456789`) y casos ambiguos. Por eso `patients.phone` NO tiene CHECK de formato: los formatos legados siguen siendo representables.

**Pase de datos (migración 003):** reescritura conservadora y con reporte. Cada fila reescrita se respalda en `phone_normalization_backup` (restaurable por `down()`); los grupos de colisión (dos o más filas que normalizan al mismo valor) se omiten completos y se registran; el reporte de consola lista CADA fila reescrita (`REWRITE`) y omitida (`SKIP<collision|no_heuristic>`). La búsqueda del bot compara `wa_id` con `patients.phone` normalizando ambos lados (`phoneMatchesLeftNormalized`), de modo que los formatos legados coinciden con el canónico al buscar.
