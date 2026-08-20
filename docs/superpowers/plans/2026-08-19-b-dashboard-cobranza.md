# Plan B — Dashboard y reportes de cobranza (backend)

> **Para ejecucion agentica:** este plan se ejecuta tarea por tarea con TDD.
> Cada tarea termina en un deliverable testeable y un commit.

**Goal:** Exponer las metricas de cobranza que hoy solo existen como filas sueltas
(planes, cuotas, pagos), para que el frontend pueda mostrar un dashboard y una
lista de mora accionable.

**Architecture:** Un modulo nuevo `src/reports/` de solo lectura. No agrega
entidades ni migraciones: consulta las tablas existentes (`payment_plans`,
`installments`, `payments`) con QueryBuilder y devuelve DTOs planos. El dinero
viaja como string decimal, igual que el resto de la API (`decimalTransformer`).

**Tech Stack:** NestJS 10, TypeORM 0.3, Postgres 18, jest + supertest.

**Spec:** decisiones de producto en `2026-08-19-roadmap-maestro.md` (seccion Dashboard).

## Global Constraints

- Roles: todos los endpoints con `@Auth(UserRole.OFFICE, UserRole.ADMIN)`.
- Prefijo global `api` (lo aplica `main.ts`), controlador en `reports`.
- Montos: siempre `string` con 2 decimales. Nunca `number` (precision).
- "Hoy" se calcula en el servidor con fecha de calendario (columna `due_date` es `date`).
- Los specs comparten `db_creditos_test` con las otras suites en paralelo:
  cada spec crea sus propios datos con sufijo unico y NUNCA truncan tablas.

---

### Task 1: Endpoint de resumen (`GET /api/reports/summary`)

**Files:**
- Create: `src/reports/reports.module.ts`
- Create: `src/reports/reports.controller.ts`
- Create: `src/reports/reports.service.ts`
- Create: `src/reports/dto/summary-query.dto.ts`
- Create: `src/reports/dto/summary-response.dto.ts`
- Create: `src/reports/dto/index.ts`
- Modify: `src/app.module.ts` (registrar `ReportsModule`)
- Test: `src/reports/reports-summary.spec.ts`

**Interfaces:**
- Produces: `ReportsService.summary(from: string, to: string): Promise<SummaryResponseDto>`
- `SummaryResponseDto`:
  - `collected: string` — suma de `payments.amount` con `status='confirmed'` y `paid_at` en rango
  - `pendingConfirmation: { count: number; amount: string }`
  - `outstandingPortfolio: string` — suma de `outstanding_balance` de planes `active`
  - `overdue: { count: number; amount: string }` — cuotas con `due_date < hoy` y estado no `paid`/`cancelled`; el monto es `total_amount - paid_amount`
  - `dueNext7Days: { count: number; amount: string }`
  - `plansByStatus: Record<PaymentPlanStatus, number>`

- [ ] **Step 1: Escribir el spec que falla** (`src/reports/reports-summary.spec.ts`)
  Inserta con SQL crudo: 1 plan `active` con 3 cuotas (una vencida impaga, una que
  vence en 3 dias, una futura), 1 pago `confirmed` dentro del mes y 1 pago
  `pending_confirmation`. Assert sobre cada campo del DTO y `expect(401)` sin token
  y `expect(403)` con token de rol `patient`.
- [ ] **Step 2: Correr y ver fallar** — `npx jest src/reports/reports-summary.spec.ts --runInBand`. Esperado: 404 (ruta inexistente).
- [ ] **Step 3: Implementar modulo, servicio y controlador** con QueryBuilder.
- [ ] **Step 4: Correr y ver pasar.**
- [ ] **Step 5: Commit** — `feat(reports): add collection summary endpoint`

---

### Task 2: Lista de mora (`GET /api/reports/overdue-installments`)

**Files:**
- Modify: `src/reports/reports.service.ts`, `src/reports/reports.controller.ts`
- Create: `src/reports/dto/overdue-installment.dto.ts`
- Test: `src/reports/reports-overdue.spec.ts`

**Interfaces:**
- Produces: `ReportsService.overdueInstallments(page, limit): Promise<PaginatedResponse<OverdueInstallmentDto>>`
- `OverdueInstallmentDto`: `{ installmentId, planId, patientId, patientName, patientPhone,
  installmentNumber, dueDate, amountDue: string, daysOverdue: number }`
- Reusa el shape de paginacion existente del proyecto (ver `src/common/dtos`).

- [ ] **Step 1: Escribir el spec que falla** — ordena por `daysOverdue` desc, pagina,
  y excluye cuotas `paid`/`cancelled`.
- [ ] **Step 2: Correr y ver fallar.**
- [ ] **Step 3: Implementar el query con join a `payment_plans` → `surgeries` → `patients`.**
- [ ] **Step 4: Correr y ver pasar.**
- [ ] **Step 5: Commit** — `feat(reports): add overdue installments list`

---

## Self-review

- Cobertura: el roadmap pide recaudado del mes, pendiente de confirmacion, cartera
  vigente, monto en mora, planes por estado y cuotas a 7 dias — todo cae en Task 1;
  la lista accionable de mora es Task 2.
- Sin placeholders: cada task nombra archivos exactos y campos exactos del DTO.
- Consistencia de tipos: `amountDue`, `amount`, `collected` y `outstandingPortfolio`
  son `string` en todas las tareas.
