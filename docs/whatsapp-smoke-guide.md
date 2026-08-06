# Guía de Smoke Test — WhatsApp Bot (Meta Cloud API)

> Guía manual para validar el bot de WhatsApp contra una **WABA de prueba** real
> (`WHATSAPP_PROVIDER=meta`). Objetivo: un revisor puede reproducir el flujo
> completo (handshake → plantilla → despacho → inbound) **sin leer código de
> implementación**. Los pre-requisitos externos de Meta son responsabilidad del
> equipo de producto (seguimiento externo, no se resuelven en código).

---

## 1. Pre-requisitos externos (checklist — Meta)

Antes de empezar, confirmar con el responsable del negocio:

- [ ] **Verificación del negocio** (Business Verification) completada en Meta
      Business Manager para la cuenta que posee la WABA.
- [ ] **WABA de prueba** creada (test number) con acceso de sistema para la app.
- [ ] **Número de teléfono aprobado**: el número de la WABA muestra estado
      `CONNECTED` en App Dashboard → WhatsApp → API Setup (los números
      nuevos requieren aprobación previa de Meta).
- [ ] **Evidencia de opt-in**: se puede demostrar consentimiento del paciente
      para recibir mensajes (política de Meta; el sistema no la exige en código).
- [ ] **Servidor accesible desde Internet** (HTTPS o túnel tipo ngrok) apuntando
      al backend, para que Meta pueda entregar los eventos del webhook.
- [ ] **Usuario office/admin** existente en la plataforma para autenticarse.

## 2. Configuración de entorno (`WHATSAPP_PROVIDER=meta`)

Copiar `.env.template` a `.env` y completar las 7 variables `WHATSAPP_*`:

| Variable                   | Valor                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `WHATSAPP_PROVIDER`        | `meta` (el adaptador de Meta Cloud API; con `mock` no hay envíos reales)                              |
| `WHATSAPP_TOKEN`           | Token de usuario de sistema de la app de Meta (Bearer para llamadas a la API)                         |
| `WHATSAPP_PHONE_NUMBER_ID` | ID numérico del número de envío (App Dashboard → API Setup)                                           |
| `WHATSAPP_APP_SECRET`      | App secret de la app de Meta (firma `x-hub-signature-256` del webhook)                                |
| `WHATSAPP_VERIFY_TOKEN`    | Token de verificación del handshake (debe coincidir con el configurado en la suscripción del webhook) |
| `WHATSAPP_WABA_ID`         | ID numérico de la WhatsApp Business Account                                                           |
| `WHATSAPP_WEBHOOK_PATH`    | Ruta del webhook (por defecto `whatsapp/webhook` → `/api/whatsapp/webhook`) — **no dejar vacía**      |

En Meta App Dashboard → WhatsApp → Configuration, registrar la URL del webhook
con la misma `WHATSAPP_WEBHOOK_PATH` y el mismo `WHATSAPP_VERIFY_TOKEN`
seleccionando los campos `messages`, `message_template_status_update` y
`message_template_quality_update`.

```bash
npm install
npm run build
npm run start:dev
```

## 3. Paso 1 — Handshake GET (verificación de la URL del webhook)

Meta envía el handshake al registrar la suscripción; también se puede probar
manualmente:

```bash
curl -i "http://localhost:3000/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=TU_VERIFY_TOKEN&hub.challenge=abc123"
```

Esperado: `200 OK` con cuerpo `abc123` (texto plano).

| Caso                      | Esperado                |
| ------------------------- | ----------------------- |
| `verify_token` incorrecto | `403 Forbidden`         |
| Parámetros faltantes      | `400 Bad Request`       |
| `verify_token` correcto   | `200` + `hub.challenge` |

Prueba de firma: un POST al webhook con firma ausente o alterada debe
responder `401`/`403` **sin procesar nada**:

```bash
curl -i -X POST "http://localhost:3000/api/whatsapp/webhook" \
  -H "Content-Type: application/json" \
  -d '{"object":"whatsapp_business_account","entry":[]}'
# Esperado: 401 Unauthorized (sin firma x-hub-signature-256)
```

## 4. Paso 2 — Plantilla: creación → aprobación (mirror)

Autenticarse como office/admin para obtener el JWT:

```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"office@example.com","password":"..."}' | jq -r .token)
```

Crear una plantilla **utility** (las plantillas de recordatorio deben ser
`utility`; los placeholders son contiguos `{{1}}…{{N}}`):

```bash
curl -i -X POST http://localhost:3000/api/whatsapp/templates \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "reminder_saldo_smoke",
    "category": "utility",
    "language": "es",
    "body": "Hola {{1}}, tu saldo pendiente es {{2}}. Próxima cuota: {{3}}.",
    "sampleVariables": {"1": "Juan", "2": "Bs 8155.19", "3": "2026-08-05"}
  }'
```

Esperado: `201` con `status: "draft"` y `id` de la plantilla.

> Nota de implementación: la creación persiste `draft`; el estado de aprobación
> llega **desde Meta vía webhook** (evento `message_template_status_update`),
> que el sistema espeja en `provider_status`/`status`.

Aprobar la plantilla en Meta:

1. Ir a **WhatsApp Manager → Account tools → Message templates** (o App
   Dashboard → WhatsApp → Message templates) con la WABA de prueba.
2. Localizar `reminder_saldo_smoke` y aprobarla (en WABAs de prueba la
   aprobación suele ser automática; en producción tarda horas/días).
3. Al aprobarse, Meta entrega el evento al webhook y el sistema espeja el
   estado. Verificar:

```bash
curl -s http://localhost:3000/api/whatsapp/templates \
  -H "Authorization: Bearer $TOKEN" | jq
# Esperado: la plantilla con "status": "approved" y "isActive": true
```

La plantilla es **despachable** solo con `status=approved` y `is_active=true`;
cualquier otro estado da `409 Conflict`.

## 5. Paso 3 — Despacho (happy path)

Con la plantilla aprobada, un paciente existente (id UUID) y variables 1:1 con
los placeholders de la plantilla:

```bash
curl -i -X POST http://localhost:3000/api/whatsapp/dispatches \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "patientId": "uuid-del-paciente",
    "templateId": "uuid-de-la-plantilla-aprobada",
    "variables": {"1": "Juan", "2": "Bs 8155.19", "3": "2026-08-05"}
  }'
```

Esperado: `201` con `{ id, status: "sent", providerMessageId }` y el paciente
recibe el mensaje en su WhatsApp.

| Caso                                         | Esperado                                                       |
| -------------------------------------------- | -------------------------------------------------------------- |
| Mismatch de variables (faltante/extra/vacía) | `400 Bad Request`, sin fila ni llamada al proveedor            |
| Plantilla no aprobada o desactivada          | `409 Conflict`                                                 |
| Mismo despacho enviado dos veces             | `409 Conflict` (dedupe por `dedupe_key`)                       |
| Despacho en estado `sent` → retry            | `POST /api/whatsapp/dispatches/:id/retry` → `200`, se re-envía |
| Despacho `delivered`/`read` → retry          | `409 Conflict` (estado terminal)                               |

Seguimiento de estados:

```bash
curl -s "http://localhost:3000/api/whatsapp/dispatches?status=delivered" \
  -H "Authorization: Bearer $TOKEN" | jq
```

Meta entrega los eventos `sent → delivered → read` al webhook; el sistema
actualiza el despacho **sin regresiones** (un `delivered` duplicado no genera
nueva auditoría ni cambio de estado).

## 6. Paso 4 — Identificación inbound (conversación del bot)

Desde un celular **cuyo número corresponda al teléfono canónico de un
paciente** (formato `+591XXXXXXXX`, o cualquier formato que el normalizador
resuelva a la misma forma canónica):

1. Enviar un mensaje de texto al número de la WABA, p. ej. `hola`.
2. Esperado: la conversación se crea (`bot_conversations` con `state`
   `unidentified` o `identified` según el número coincida con exactamente un
   paciente) y el bot responde por WhatsApp.
3. Si el número no coincide de forma unívoca, el bot responde pidiendo el
   `identity_document`; responder con el documento correcto del paciente
   identifica la conversación.
4. Estando identificado, enviar `saldo` (o `cuotas` / `proxima`) dentro de la
   ventana de 24h: el bot responde con saldo pendiente, próxima cuota y total
   vencido como strings decimales (p. ej. `Bs 8155.19`).
5. Tras 3 intentos fallidos de identificación, el bot bloquea el número por
   24h y reenvía la guía de contacto con la clínica (lockout suave).

Verificación (no hay superficie HTTP para conversaciones — inspeccionar la DB):

```sql
-- conversación y mensajes del número
SELECT wa_id, state, patient_id, failed_attempts, lockout_until
  FROM bot_conversations ORDER BY started_at DESC LIMIT 5;

SELECT direction, type, body, intent, metadata
  FROM bot_messages ORDER BY created_at DESC LIMIT 10;
```

| Caso                                 | Esperado                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| Número coincide con un solo paciente | Conversación `identified` con `patient_id` seteado (auditoría `bot_conversation.identified`) |
| Número sin coincidencia              | `awaiting_document` y pedido de documento                                                    |
| Documento correcto                   | Conversación pasa a `identified`                                                             |
| Fuera de la ventana de 24h           | Respuesta SOLO por plantilla utility aprobada+activa, nunca texto libre                      |

## 7. Limpieza / rollback

- Cambiar `WHATSAPP_PROVIDER=mock` en `.env` y reiniciar: se detienen los
  envíos reales al instante (el webhook verifica firma y falla cerrado ante
  eventos inválidos).
- Las filas de prueba (`message_templates`, `whatsapp_dispatches`,
  `bot_conversations`, `bot_messages`) se pueden eliminar manualmente; la
  migración `1786000000003` es aditiva y su `down()` revierte el esquema.
- Los datos de la pasada de normalización telefónica se restauran con el
  `down()` de la migración (tabla `phone_normalization_backup`).

---

## Referencia rápida de endpoints

| Endpoint                                        | Auth            | Descripción                         |
| ----------------------------------------------- | --------------- | ----------------------------------- |
| `GET/POST /api/whatsapp/webhook`                | pública (firma) | Handshake + eventos de Meta         |
| `POST /api/whatsapp/templates`                  | office/admin    | Crear plantilla (nace `draft`)      |
| `GET /api/whatsapp/templates?status=&category=` | office/admin    | Listar/filtrar                      |
| `PATCH /api/whatsapp/templates/:id`             | office/admin    | Actualizar (PATCH)                  |
| `PATCH /api/whatsapp/templates/:id/deactivate`  | office/admin    | Desactivar (bloquea despachos)      |
| `POST /api/whatsapp/dispatches`                 | office/admin    | Crear + enviar despacho             |
| `POST /api/whatsapp/dispatches/:id/retry`       | office/admin    | Reintentar (`queued`/`failed` only) |
| `GET /api/whatsapp/dispatches?status=`          | office/admin    | Lista paginada con filtro           |

Variables de entorno usadas: `WHATSAPP_PROVIDER`, `WHATSAPP_TOKEN`,
`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`,
`WHATSAPP_WABA_ID`, `WHATSAPP_WEBHOOK_PATH` (documentadas en `.env.template`).
