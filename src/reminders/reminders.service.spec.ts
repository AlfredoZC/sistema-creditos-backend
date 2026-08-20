import { INestApplication } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ReminderKind,
  TemplateCategory,
  TemplateStatus,
} from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { MockWhatsAppProvider } from '../whatsapp/provider/mock-whatsapp-provider';
import { WHATSAPP_PROVIDER } from '../whatsapp/provider/whatsapp-provider.token';
import { RemindersService } from './reminders.service';

jest.setTimeout(60000);

const RUN_SUFFIX = `${process.pid}${Date.now()}`;
const SHORT_SUFFIX = RUN_SUFFIX.slice(-10);
let uniqueCounter = 0;

interface IdRow {
  id: string;
}

interface CountRow {
  count: string;
}

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

describe('RemindersService', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let service: RemindersService;
  let provider: MockWhatsAppProvider;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    service = app.get(RemindersService);
    provider = app.get(WHATSAPP_PROVIDER);
    await ensureTemplate('payment_reminder');
    await ensureTemplate('payment_overdue');
    await markExistingInstallmentsAsAlreadyReminded();
  });

  /**
   * La base de test es compartida: cuando corre la suite completa hay cientos
   * de cuotas vencidas de otras suites, y `run()` intentaria despachar todas,
   * pasandose del timeout por razones ajenas a lo que este spec verifica.
   *
   * Marcar lo preexistente como ya notificado deja un punto de partida
   * conocido sin tocar datos de nadie: `installment_reminders` es una tabla que
   * solo usa este modulo.
   */
  async function markExistingInstallmentsAsAlreadyReminded(): Promise<void> {
    await dataSource.query(
      `INSERT INTO installment_reminders (installment_id, kind)
       SELECT i.id, k.kind::installment_reminder_kind
         FROM installments i
        CROSS JOIN (VALUES ('due_soon'), ('overdue')) AS k(kind)
       ON CONFLICT (installment_id, kind) DO NOTHING`,
    );
  }

  afterAll(async () => {
    await app.close();
  });

  /**
   * El job resuelve la plantilla por nombre. En una base de test que no corrio
   * el seed puede no existir, asi que la suite se la garantiza (aprobada y
   * activa, que es la unica combinacion despachable).
   */
  async function ensureTemplate(name: string): Promise<void> {
    await dataSource.query(
      `INSERT INTO message_templates
         (name, category, language, body_template, sample_variables, status,
          provider_template_id, provider_status, is_active)
       VALUES ($1, $2, 'es',
               'Estimado(a) {{1}}, su cuota {{2}} con vencimiento {{3}}.',
               '{"1":"Ana","2":"1","3":"2026-01-01"}', $3,
               $4, 'approved', true)
       ON CONFLICT (name, language) DO UPDATE
         SET status = EXCLUDED.status, is_active = true`,
      [
        name,
        TemplateCategory.UTILITY,
        TemplateStatus.APPROVED,
        `HBT_${name.toUpperCase()}`,
      ],
    );
  }

  async function insertPlanWithInstallment(
    dueDate: string,
    installmentStatus: string,
    planStatus = 'active',
  ): Promise<{ installmentId: string; patientId: string }> {
    const patientRows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Luis', 'Vargas', $2)
       RETURNING id`,
      [
        `R${SHORT_SUFFIX}${uniqueCounter++}`,
        `+591${SHORT_SUFFIX}${uniqueCounter++}`,
      ],
    );
    const catalogRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, base_cost)
       VALUES ($1, '3000.00') RETURNING id`,
      [`Recordatorio-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    const surgeryRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, $3, '3000.00') RETURNING id`,
      [patientRows[0].id, catalogRows[0].id, isoDaysFromToday(-60)],
    );
    const planRows: IdRow[] = await dataSource.query(
      `INSERT INTO payment_plans
         (surgery_id, type, down_payment, financed_amount, monthly_interest_rate,
          installment_count, start_date, outstanding_balance, status)
       VALUES ($1, 'credit', '0.00', '600.00', '2.00', 2, $2, '600.00', $3)
       RETURNING id`,
      [surgeryRows[0].id, isoDaysFromToday(-60), planStatus],
    );
    const installmentRows: IdRow[] = await dataSource.query(
      `INSERT INTO installments
         (payment_plan_id, installment_number, principal_amount, interest_amount,
          total_amount, paid_amount, due_date, status)
       VALUES ($1, 1, '300.00', '0.00', '300.00', '0.00', $2, $3)
       RETURNING id`,
      [planRows[0].id, dueDate, installmentStatus],
    );
    return {
      installmentId: installmentRows[0].id,
      patientId: patientRows[0].id,
    };
  }

  async function remindersFor(installmentId: string): Promise<number> {
    const rows: CountRow[] = await dataSource.query(
      `SELECT COUNT(*)::text AS count FROM installment_reminders
        WHERE installment_id = $1`,
      [installmentId],
    );
    return Number(rows[0].count);
  }

  it('sends a due-soon reminder three days before the due date', async () => {
    const { installmentId } = await insertPlanWithInstallment(
      isoDaysFromToday(3),
      'pending',
    );
    const sentBefore = provider.sent.length;

    await service.run();

    expect(await remindersFor(installmentId)).toBe(1);
    expect(provider.sent.length).toBeGreaterThan(sentBefore);
  });

  it('sends an overdue reminder for an installment past its due date', async () => {
    const { installmentId } = await insertPlanWithInstallment(
      isoDaysFromToday(-2),
      'overdue',
    );

    await service.run();

    const rows: { kind: ReminderKind }[] = await dataSource.query(
      `SELECT kind FROM installment_reminders WHERE installment_id = $1`,
      [installmentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe(ReminderKind.OVERDUE);
  });

  it('never sends the same reminder twice, even if the job runs again', async () => {
    const { installmentId } = await insertPlanWithInstallment(
      isoDaysFromToday(3),
      'pending',
    );

    await service.run();
    const sentAfterFirstRun = provider.sent.length;
    await service.run();

    // Una sola fila y ningun envio nuevo: la idempotencia se ve por dos lados.
    // El query ya descarta las cuotas con recordatorio previo, asi que la
    // cuota ni siquiera vuelve a ser candidata; el contador `skipped` cubre el
    // caso restante, cuando dos instancias corren a la vez y la UNIQUE decide.
    expect(await remindersFor(installmentId)).toBe(1);
    expect(provider.sent.length).toBe(sentAfterFirstRun);
  });

  it('does not resend when the reminder row already exists', async () => {
    const { installmentId } = await insertPlanWithInstallment(
      isoDaysFromToday(3),
      'pending',
    );
    // Simula el recordatorio ya enviado por una corrida anterior.
    await dataSource.query(
      `INSERT INTO installment_reminders (installment_id, kind) VALUES ($1, $2)`,
      [installmentId, ReminderKind.DUE_SOON],
    );
    const sentBefore = provider.sent.length;

    await service.run();

    expect(await remindersFor(installmentId)).toBe(1);
    expect(provider.sent.length).toBe(sentBefore);
  });

  it('ignores installments that are already paid', async () => {
    const { installmentId } = await insertPlanWithInstallment(
      isoDaysFromToday(3),
      'paid',
    );

    await service.run();

    expect(await remindersFor(installmentId)).toBe(0);
  });

  it('ignores installments of cancelled plans', async () => {
    const { installmentId } = await insertPlanWithInstallment(
      isoDaysFromToday(-4),
      'overdue',
      'cancelled',
    );

    await service.run();

    expect(await remindersFor(installmentId)).toBe(0);
  });
});
