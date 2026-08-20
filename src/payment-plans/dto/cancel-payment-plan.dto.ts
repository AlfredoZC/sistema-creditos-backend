import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Anular un plan es irreversible y borra deuda: el motivo es obligatorio para
 * que quede en la auditoria quien lo hizo y por que.
 */
export class CancelPaymentPlanDto {
  @ApiProperty({ example: 'La cirugia no se realizo' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
