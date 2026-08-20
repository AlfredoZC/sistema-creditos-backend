import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ReminderKind } from '../common/enums';
import { DispatchesService } from '../whatsapp/dispatches.service';

/** Cuantos dias antes del vencimiento se avisa. */
const DUE_SOON_LEAD_DAYS = 3;

/** Cuotas que ya no se cobran: no generan recordatorio. */
const SETTLED_INSTALLMENT_STATUSES = ['paid', 'cancelled'];

/** Planes cerrados: sus cuotas viejas no deben molestar al paciente. */
const CLOSED_PLAN_STATUSES = ['cancelled', 'completed'];

/**
 * Tope de despachos por corrida y por tipo. Sin el, la primera corrida sobre
 * una cartera con años de mora acumulada intentaria mandar miles de mensajes
 * de una sentada, castigando al proveedor y dejando la corrida colgada. Como
 * lo ya enviado nunca se repite, el atraso se drena en las corridas
 * siguientes.
 */
const DEFAULT_MAX_PER_RUN = 200;

const DEFAULT_TEMPLATE_DUE_SOON = 'payment_reminder';
const DEFAULT_TEMPLATE_OVERDUE = 'payment_overdue';

export interface ReminderRunResult {
  dueSoon: number;
  overdue: number;
  skipped: number;
  failed: number;
}

interface CandidateRow {
  installmentId: string;
  patientId: string;
  patientName: string;
  installmentNumber: string;
  dueDate: string;
}

interface TemplateRow {
  id: string;
}

interface InsertedReminderRow {
  id: string;
}

/**
 * Recordatorios de cuota por WhatsApp.
 *
 * Dos garantias sostienen este servicio:
 *
 * 1. **Idempotencia por base de datos.** Antes de despachar se inserta la fila
 *    en `installment_reminders`; la UNIQUE (installment_id, kind) hace que una
 *    segunda corrida -o dos instancias simultaneas- no puedan mandar el mismo
 *    aviso dos veces. La verificacion no vive en memoria del proceso.
 *
 * 2. **Nunca tumba el proceso.** El job corre solo, de madrugada: si una
 *    plantilla no existe o el proveedor falla, se registra y se sigue con las
 *    demas cuotas. Una excepcion propagada dejaria sin avisar a todos los
 *    pacientes que venian despues en la lista.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger(RemindersService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly dispatchesService: DispatchesService,
    private readonly configService: ConfigService,
  ) {}

  async run(): Promise<ReminderRunResult> {
    const result: ReminderRunResult = {
      dueSoon: 0,
      overdue: 0,
      skipped: 0,
      failed: 0,
    };

    await this.processKind(ReminderKind.DUE_SOON, result);
    await this.processKind(ReminderKind.OVERDUE, result);

    this.logger.log(
      `Recordatorios: ${result.dueSoon} por vencer, ${result.overdue} vencidas, ` +
        `${result.skipped} ya enviados, ${result.failed} fallidos`,
    );
    return result;
  }

  private async processKind(
    kind: ReminderKind,
    result: ReminderRunResult,
  ): Promise<void> {
    const templateId = await this.templateIdFor(kind);
    if (!templateId) {
      // Sin plantilla despachable no hay nada que mandar; no es un error fatal.
      this.logger.warn(
        `Sin plantilla aprobada y activa para '${this.templateNameFor(kind)}': ` +
          `se omiten los recordatorios de tipo ${kind}`,
      );
      return;
    }

    const candidates = await this.candidates(kind, this.maxPerRun());
    for (const candidate of candidates) {
      const reminderId = await this.claim(candidate.installmentId, kind);
      if (!reminderId) {
        // Otra corrida ya lo mando: la UNIQUE hizo su trabajo.
        result.skipped += 1;
        continue;
      }

      try {
        const dispatch = await this.dispatchesService.create({
          patientId: candidate.patientId,
          templateId,
          variables: {
            '1': candidate.patientName,
            '2': String(candidate.installmentNumber),
            '3': candidate.dueDate,
          },
        });
        await this.dataSource.query(
          `UPDATE installment_reminders SET dispatch_id = $1 WHERE id = $2`,
          [dispatch.id, reminderId],
        );
        if (kind === ReminderKind.DUE_SOON) {
          result.dueSoon += 1;
        } else {
          result.overdue += 1;
        }
      } catch (error) {
        // La fila queda sin dispatch_id: sirve de marca de que se intento y
        // evita reintentos infinitos en cada corrida diaria.
        result.failed += 1;
        this.logger.error(
          `Fallo el recordatorio ${kind} de la cuota ${candidate.installmentId}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Inserta la marca de "recordatorio enviado" ANTES de despachar. Devuelve el
   * id de la fila nueva, o null si ya existia (ON CONFLICT DO NOTHING no
   * devuelve filas).
   */
  private async claim(
    installmentId: string,
    kind: ReminderKind,
  ): Promise<string | null> {
    const rows: InsertedReminderRow[] = await this.dataSource.query(
      `INSERT INTO installment_reminders (installment_id, kind)
       VALUES ($1, $2)
       ON CONFLICT (installment_id, kind) DO NOTHING
       RETURNING id`,
      [installmentId, kind],
    );
    return rows.length > 0 ? rows[0].id : null;
  }

  private maxPerRun(): number {
    const configured = Number(
      this.configService.get<string>('REMINDER_MAX_PER_RUN'),
    );
    return Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_MAX_PER_RUN;
  }

  private async candidates(
    kind: ReminderKind,
    limit: number,
  ): Promise<CandidateRow[]> {
    // Los dos tipos comparten el mismo query salvo la condicion de fecha, que
    // ademas cambia la cantidad de parametros. Se arma la lista primero y el
    // indice de `kind` se calcula a partir de ella: Postgres rechaza el query
    // si sobra o falta un parametro.
    const parameters: unknown[] = [
      SETTLED_INSTALLMENT_STATUSES,
      CLOSED_PLAN_STATUSES,
    ];
    let dateCondition = `i.due_date < CURRENT_DATE`;
    if (kind === ReminderKind.DUE_SOON) {
      parameters.push(DUE_SOON_LEAD_DAYS);
      dateCondition = `i.due_date = CURRENT_DATE + $${parameters.length}::integer`;
    }
    parameters.push(kind);
    const kindParameter = `$${parameters.length}`;
    parameters.push(limit);
    const limitParameter = `$${parameters.length}`;

    return this.dataSource.query(
      `SELECT i.id                                    AS "installmentId",
              pa.id                                   AS "patientId",
              CONCAT_WS(' ', pa.first_name, pa.paternal_last_name) AS "patientName",
              i.installment_number                    AS "installmentNumber",
              to_char(i.due_date, 'YYYY-MM-DD')       AS "dueDate"
         FROM installments i
         JOIN payment_plans p ON p.id = i.payment_plan_id
         JOIN surgeries s     ON s.id = p.surgery_id
         JOIN patients pa     ON pa.id = s.patient_id
    LEFT JOIN installment_reminders r
           ON r.installment_id = i.id AND r.kind = ${kindParameter}
        WHERE ${dateCondition}
          AND i.status <> ALL($1)
          AND p.status <> ALL($2)
          AND r.id IS NULL
        ORDER BY i.due_date ASC
        LIMIT ${limitParameter}`,
      parameters,
    );
  }

  private templateNameFor(kind: ReminderKind): string {
    return kind === ReminderKind.DUE_SOON
      ? (this.configService.get<string>('REMINDER_TEMPLATE_DUE_SOON') ??
          DEFAULT_TEMPLATE_DUE_SOON)
      : (this.configService.get<string>('REMINDER_TEMPLATE_OVERDUE') ??
          DEFAULT_TEMPLATE_OVERDUE);
  }

  /** Solo una plantilla aprobada y activa puede despacharse. */
  private async templateIdFor(kind: ReminderKind): Promise<string | null> {
    const rows: TemplateRow[] = await this.dataSource.query(
      `SELECT id FROM message_templates
        WHERE name = $1 AND status = 'approved' AND is_active = true
        LIMIT 1`,
      [this.templateNameFor(kind)],
    );
    return rows.length > 0 ? rows[0].id : null;
  }
}
