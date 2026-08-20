# Roadmap maestro — cierre de v1 (backend + frontend)

**Fecha:** 2026-08-19
**Repos:** `sistema-creditos-backend` (NestJS) y `sistema-creditos` (React + Vite)

Cada sub-proyecto produce software funcionando por si solo y tiene su propio
plan detallado en este directorio, escrito justo antes de ejecutarlo.

## Orden de ejecucion

| # | Sub-proyecto | Repo | Plan |
|---|---|---|---|
| A | CI (lint + build + 48 suites contra Postgres) | backend | bounded, sin plan doc |
| B | Dashboard / reportes de cobranza | backend | `2026-08-19-b-dashboard-cobranza.md` |
| C | Recordatorios automaticos (scheduler WhatsApp) | backend | `2026-08-19-c-recordatorios.md` |
| D | Portales paciente y doctor (API) | backend | `2026-08-19-d-portales-api.md` |
| E | Ejecucion local completa (compose API+DB, docs de arranque) | backend | `2026-08-19-e-local.md` |
| F | Tests + CI frontend (Vitest) | frontend | plan en repo frontend |
| G | Dashboard UI | frontend | plan en repo frontend |
| H | Portales UI | frontend | plan en repo frontend |
| I | E2E Playwright (local) | frontend | plan en repo frontend |

## Decisiones de producto tomadas por defecto

El usuario delego estas decisiones ("tienes mi si a todo"). Quedan documentadas
aca para que las revise y ajuste.

### Portal del paciente (rol `patient`)
- Ve UNICAMENTE sus propios datos, resueltos desde el JWT — nunca por id en la URL.
- Alcance: sus cirugias, su(s) plan(es) de pago, el cronograma de cuotas con estado,
  y el historial de pagos con su estado de confirmacion.
- Puede registrar un pago (queda `pending_confirmation`, igual que hoy) — no puede
  confirmarlo ni rechazarlo.
- No ve costos internos del doctor ni datos de otros pacientes.

### Portal del doctor (rol `doctor`)
- Ve las cirugias donde esta asignado (cualquier rol: principal, asistente,
  anestesiologo), resueltas desde el JWT.
- Ve los datos de contacto del paciente de esas cirugias, no su situacion financiera
  completa: el doctor no necesita ver deuda ni cuotas.
- Puede actualizar su propio perfil.

### Dashboard (roles `office`/`admin`)
- Metricas: recaudado del mes, pendiente de confirmacion, cartera vigente,
  monto en mora, cantidad de planes por estado, cuotas que vencen en 7 dias.
- El corte por defecto es el mes calendario en curso.

### Recordatorios automaticos
- Un job diario que despacha, por WhatsApp, recordatorio de cuota proxima a vencer
  (3 dias antes) y aviso de cuota vencida.
- Idempotente: una cuota no genera dos veces el mismo tipo de recordatorio.
- Corre contra el provider `mock` mientras no haya credenciales reales de Meta.

## Fuera de alcance (decision explicita del usuario, 2026-08-19)

- **No hay deploy a la nube.** El objetivo es que todo corra completo en local.
  No se provisiona hosting ni base de datos remota.
- **No hay WhatsApp productivo.** Todo corre contra el provider `mock`; el
  adaptador Meta queda implementado pero sin credenciales reales.
- Credenciales de Cloudinary: opcionales, la subida de imagen se prueba con doble.
