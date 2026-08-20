import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RemindersService } from './reminders.service';

/**
 * Dispara el job diario. Vive separado del servicio para que `RemindersService`
 * siga siendo invocable a mano (endpoint y tests) sin arrastrar el scheduler.
 *
 * 9 AM: temprano para que cobranza pueda hacer seguimiento el mismo dia, pero
 * no a una hora en que un WhatsApp molesta.
 */
@Injectable()
export class RemindersScheduler {
  private readonly logger = new Logger(RemindersScheduler.name);

  constructor(private readonly remindersService: RemindersService) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM, { name: 'installment-reminders' })
  async handleDailyRun(): Promise<void> {
    try {
      await this.remindersService.run();
    } catch (error) {
      // Una excepcion que escape del cron tumbaria el scheduler para las
      // corridas siguientes: se registra y se sigue.
      this.logger.error(
        `La corrida diaria de recordatorios fallo: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
