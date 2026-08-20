import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import Decimal from 'decimal.js';
import { DataSource } from 'typeorm';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { PaymentPlanStatus } from '../common/enums';
import {
  OverdueInstallmentDto,
  SummaryQueryDto,
  SummaryResponseDto,
} from './dto';

interface AmountRow {
  amount: string | null;
}

/** Fila cruda del query de mora: todo llega como texto desde pg. */
interface OverdueQueryRow {
  installmentId: string;
  planId: string;
  patientId: string;
  patientName: string;
  patientPhone: string;
  installmentNumber: string;
  dueDate: string;
  amountDue: string;
  daysOverdue: string;
  total: string;
}

export interface PaginatedOverdue {
  data: OverdueInstallmentDto[];
  total: number;
  limit: number;
  offset: number;
}

interface BucketRow {
  count: string;
  amount: string | null;
}

interface StatusCountRow {
  status: PaymentPlanStatus;
  count: string;
}

/**
 * Estados de cuota que ya no se cobran: no entran en mora ni en el bucket de
 * proximos vencimientos.
 */
const SETTLED_INSTALLMENT_STATUSES = ['paid', 'cancelled'];

/**
 * Estados de plan que dejan de generar cobranza. Un plan cancelado o completado
 * puede tener cuotas viejas sin saldar; contarlas como mora inflaria el numero.
 */
const CLOSED_PLAN_STATUSES = ['cancelled', 'completed'];

@Injectable()
export class ReportsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async summary(query: SummaryQueryDto): Promise<SummaryResponseDto> {
    const { from, to } = resolveRange(query);

    const [collectedRows, pendingRows, portfolioRows, overdueRows, dueRows] =
      await Promise.all([
        this.collected(from, to),
        this.pendingConfirmation(),
        this.outstandingPortfolio(),
        this.overdue(),
        this.dueWithinDays(7),
      ]);

    return {
      from,
      to,
      collected: money(collectedRows.amount),
      pendingConfirmation: bucket(pendingRows),
      outstandingPortfolio: money(portfolioRows.amount),
      overdue: bucket(overdueRows),
      dueNext7Days: bucket(dueRows),
      plansByStatus: await this.plansByStatus(),
    };
  }

  /**
   * Cuotas vencidas sin saldar, con el paciente detras y ordenadas por
   * antiguedad: es la cola de trabajo de cobranza. Devuelve el mismo shape de
   * paginacion que los demas listados ({ data, total, limit, offset }).
   */
  async overdueInstallments(
    pagination: PaginationDto,
  ): Promise<PaginatedOverdue> {
    const { limit = 10, offset = 0 } = pagination;

    const rows: OverdueQueryRow[] = await this.dataSource.query(
      `SELECT i.id                                            AS "installmentId",
              p.id                                            AS "planId",
              pa.id                                           AS "patientId",
              CONCAT_WS(' ', pa.first_name, pa.paternal_last_name,
                        pa.maternal_last_name)                AS "patientName",
              pa.phone                                        AS "patientPhone",
              i.installment_number                            AS "installmentNumber",
              to_char(i.due_date, 'YYYY-MM-DD')               AS "dueDate",
              (i.total_amount - i.paid_amount)::text          AS "amountDue",
              (CURRENT_DATE - i.due_date)::integer            AS "daysOverdue",
              COUNT(*) OVER ()::text                          AS "total"
         FROM installments i
         JOIN payment_plans p ON p.id = i.payment_plan_id
         JOIN surgeries s     ON s.id = p.surgery_id
         JOIN patients pa     ON pa.id = s.patient_id
        WHERE i.due_date < CURRENT_DATE
          AND i.status <> ALL($1)
          AND p.status <> ALL($2)
        ORDER BY i.due_date ASC, i.installment_number ASC
        LIMIT $3 OFFSET $4`,
      [SETTLED_INSTALLMENT_STATUSES, CLOSED_PLAN_STATUSES, limit, offset],
    );

    return {
      // COUNT(*) OVER () viaja en cada fila; sin filas, el total es 0.
      total: rows.length > 0 ? Number(rows[0].total) : 0,
      limit,
      offset,
      data: rows.map((row) => ({
        installmentId: row.installmentId,
        planId: row.planId,
        patientId: row.patientId,
        patientName: row.patientName,
        patientPhone: row.patientPhone,
        installmentNumber: Number(row.installmentNumber),
        dueDate: row.dueDate,
        amountDue: money(row.amountDue),
        daysOverdue: Number(row.daysOverdue),
      })),
    };
  }

  /**
   * Solo pagos confirmados: un pago pendiente todavia puede rechazarse, asi que
   * contarlo como recaudado mostraria plata que no entro.
   *
   * `paid_at` es timestamptz y el rango llega como fecha: el extremo superior se
   * compara contra el dia siguiente para incluir todo el ultimo dia.
   */
  private async collected(from: string, to: string): Promise<AmountRow> {
    const rows: AmountRow[] = await this.dataSource.query(
      `SELECT SUM(amount)::text AS amount
         FROM payments
        WHERE status = 'confirmed'
          AND paid_at >= $1::date
          AND paid_at < ($2::date + INTERVAL '1 day')`,
      [from, to],
    );
    return rows[0];
  }

  private async pendingConfirmation(): Promise<BucketRow> {
    const rows: BucketRow[] = await this.dataSource.query(
      `SELECT COUNT(*)::text AS count, SUM(amount)::text AS amount
         FROM payments
        WHERE status = 'pending_confirmation'`,
    );
    return rows[0];
  }

  private async outstandingPortfolio(): Promise<AmountRow> {
    const rows: AmountRow[] = await this.dataSource.query(
      `SELECT SUM(outstanding_balance)::text AS amount
         FROM payment_plans
        WHERE status = 'active'`,
    );
    return rows[0];
  }

  private async overdue(): Promise<BucketRow> {
    const rows: BucketRow[] = await this.dataSource.query(
      `SELECT COUNT(*)::text AS count,
              SUM(i.total_amount - i.paid_amount)::text AS amount
         FROM installments i
         JOIN payment_plans p ON p.id = i.payment_plan_id
        WHERE i.due_date < CURRENT_DATE
          AND i.status <> ALL($1)
          AND p.status <> ALL($2)`,
      [SETTLED_INSTALLMENT_STATUSES, CLOSED_PLAN_STATUSES],
    );
    return rows[0];
  }

  private async dueWithinDays(days: number): Promise<BucketRow> {
    const rows: BucketRow[] = await this.dataSource.query(
      `SELECT COUNT(*)::text AS count,
              SUM(i.total_amount - i.paid_amount)::text AS amount
         FROM installments i
         JOIN payment_plans p ON p.id = i.payment_plan_id
        WHERE i.due_date >= CURRENT_DATE
          AND i.due_date <= CURRENT_DATE + $1::integer
          AND i.status <> ALL($2)
          AND p.status <> ALL($3)`,
      [days, SETTLED_INSTALLMENT_STATUSES, CLOSED_PLAN_STATUSES],
    );
    return rows[0];
  }

  /**
   * Devuelve los cuatro estados siempre presentes (en cero si no hay planes),
   * para que el frontend no tenga que defenderse de claves faltantes.
   */
  private async plansByStatus(): Promise<Record<PaymentPlanStatus, number>> {
    const rows: StatusCountRow[] = await this.dataSource.query(
      `SELECT status, COUNT(*)::text AS count FROM payment_plans GROUP BY status`,
    );
    const counts = Object.values(PaymentPlanStatus).reduce(
      (accumulator, status) => ({ ...accumulator, [status]: 0 }),
      {} as Record<PaymentPlanStatus, number>,
    );
    for (const row of rows) {
      counts[row.status] = Number(row.count);
    }
    return counts;
  }
}

/**
 * Rango por defecto: el mes calendario en curso. Se calcula con la fecha local
 * del servidor, que es la misma referencia que usa CURRENT_DATE en Postgres
 * cuando la base corre en la misma zona.
 */
function resolveRange(query: SummaryQueryDto): { from: string; to: string } {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  return {
    from: query.from ?? toIsoDate(firstOfMonth),
    to: query.to ?? toIsoDate(lastOfMonth),
  };
}

function toIsoDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** SUM() sobre cero filas devuelve NULL; para el cliente eso es 0.00. */
function money(value: string | null): string {
  return new Decimal(value ?? 0).toFixed(2);
}

function bucket(row: BucketRow): { count: number; amount: string } {
  return { count: Number(row.count), amount: money(row.amount) };
}
