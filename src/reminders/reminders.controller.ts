import { Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators';
import { UserRole } from '../common/enums';
import { ReminderRunResult, RemindersService } from './reminders.service';

@ApiTags('Reminders')
@Controller('reminders')
export class RemindersController {
  constructor(private readonly remindersService: RemindersService) {}

  /**
   * Disparo manual de la corrida diaria. Solo admin: manda WhatsApps reales a
   * pacientes cuando el proveedor es `meta`. Es idempotente, asi que ejecutarlo
   * dos veces no duplica avisos.
   */
  @Post('run')
  @Auth(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiResponse({
    status: 200,
    description: 'Cuantos recordatorios se enviaron, omitieron y fallaron',
  })
  run(): Promise<ReminderRunResult> {
    return this.remindersService.run();
  }
}
