import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * Filtros del historial de pagos.
 *
 * `paymentPlanId` no es opcional por comodidad: el detalle de un plan lo manda
 * siempre, y sin el la pantalla mostraba los pagos de TODOS los planes como si
 * fueran de ese paciente.
 */
export class PaymentQueryDto {
  @ApiPropertyOptional({ description: 'Devuelve solo los pagos de ese plan' })
  @IsOptional()
  @IsUUID()
  paymentPlanId?: string;
}
