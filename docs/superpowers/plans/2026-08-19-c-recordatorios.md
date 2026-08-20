# Plan C — Recordatorios automaticos de cuotas (backend)

**Goal:** Que el sistema avise solo, por WhatsApp, cuando una cuota esta por vencer
o ya vencio, sin que nadie tenga que disparar el despacho a mano.

**Architecture:** Un `RemindersService` con un job programado (`@nestjs/schedule`)
que corre una vez por dia, busca cuotas objetivo y delega en el `DispatchesService`
que ya existe. No habla con Meta directamente: reusa el puerto `WhatsAppProvider`,
asi que con `WHATSAPP_PROVIDER=mock` no sale ningun mensaje real. La idempotencia
se garantiza con una tabla nueva `installment_reminders` (una fila por cuota+tipo).

**Tech Stack:** NestJS 10 + `@nestjs/schedule`, TypeORM migration, jest.

**Spec:** `2026-08-19-roadmap-maestro.md` (seccion Recordatorios automaticos).

## Global Constraints

- Idempotente: una cuota nunca genera dos veces el mismo tipo de recordatorio.
- El job NUNCA debe tumbar el proceso: un fallo de un despacho se registra y sigue.
- Se puede disparar manualmente para pruebas (`POST /api/reminders/run`, admin).
- Corre siempre contra el provider configurado; en tests, el mock.

---

### Task 1: Migracion + entidad `installment_reminders`

**Files:**
- Create: `src/database/migrations/1786000000005-InstallmentReminders.ts`
- Create: `src/reminders/entities/installment-reminder.entity.ts`
- Test: `src/database/migrations/installment-reminders.migration.spec.ts`

**Interfaces:**
- Tabla: `id uuid PK`, `installment_id uuid FK→installments`, `kind enum('due_soon','overdue')`,
  `dispatch_id uuid FK→whatsapp_dispatches NULL`, `sent_at timestamptz default now()`.
- Indice unico `uq_installment_reminders_installment_kind (installment_id, kind)` — ES la idempotencia.

- [ ] Step 1: spec que corre la migracion y verifica columnas + unicidad
- [ ] Step 2: correr, ver fallar
- [ ] Step 3: escribir migracion + entidad
- [ ] Step 4: correr, ver pasar
- [ ] Step 5: commit `feat(reminders): add installment_reminders table`

---

### Task 2: `RemindersService.run()` con seleccion e idempotencia

**Files:**
- Create: `src/reminders/reminders.service.ts`, `src/reminders/reminders.module.ts`
- Test: `src/reminders/reminders.service.spec.ts`

**Interfaces:**
- Produces: `RemindersService.run(today?: string): Promise<{ dueSoon: number; overdue: number; skipped: number }>`
- Selecciona `due_soon`: cuotas con `due_date = hoy + 3 dias`, estado `pending`/`partial`.
- Selecciona `overdue`: cuotas con `due_date < hoy`, estado `pending`/`partial`/`overdue`.
- Excluye planes `cancelled`/`completed` y pacientes sin telefono.
- Antes de despachar, inserta la fila de `installment_reminders`; si el unique la
  rechaza, cuenta como `skipped` y no despacha.

- [ ] Step 1: spec — dos corridas seguidas despachan una sola vez (idempotencia)
- [ ] Step 2: correr, ver fallar
- [ ] Step 3: implementar
- [ ] Step 4: correr, ver pasar
- [ ] Step 5: commit `feat(reminders): add daily reminder selection with idempotency`

---

### Task 3: Job diario + endpoint manual

**Files:**
- Modify: `src/reminders/reminders.module.ts` (registrar `ScheduleModule`)
- Create: `src/reminders/reminders.controller.ts`
- Modify: `src/app.module.ts`
- Test: `src/reminders/reminders.controller.spec.ts`

- [ ] Step 1: spec — `POST /api/reminders/run` exige rol admin (401/403) y devuelve el conteo
- [ ] Step 2: correr, ver fallar
- [ ] Step 3: implementar controlador + `@Cron('0 9 * * *')`
- [ ] Step 4: correr, ver pasar
- [ ] Step 5: commit `feat(reminders): schedule daily run and manual trigger`
