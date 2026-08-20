import { ApiProperty } from '@nestjs/swagger';
import { PaymentPlanStatus } from '../../common/enums';

/** Un bucket de cuotas: cuantas son y cuanto falta cobrar de ellas. */
export class BucketDto {
  @ApiProperty({ example: 3 })
  count: number;

  @ApiProperty({
    example: '1250.00',
    description: 'Monto como string decimal con 2 decimales',
  })
  amount: string;
}

export class SummaryResponseDto {
  @ApiProperty({ example: '2026-08-01' })
  from: string;

  @ApiProperty({ example: '2026-08-31' })
  to: string;

  @ApiProperty({
    example: '4300.00',
    description: 'Pagos confirmados con fecha de pago dentro del rango',
  })
  collected: string;

  @ApiProperty({
    description:
      'Pagos que esperan confirmacion. Es una foto del momento, no depende del rango',
  })
  pendingConfirmation: BucketDto;

  @ApiProperty({
    example: '18400.00',
    description: 'Suma de saldos pendientes de los planes activos',
  })
  outstandingPortfolio: string;

  @ApiProperty({
    description: 'Cuotas con vencimiento anterior a hoy que siguen sin saldar',
  })
  overdue: BucketDto;

  @ApiProperty({
    description: 'Cuotas que vencen entre hoy y los proximos 7 dias',
  })
  dueNext7Days: BucketDto;

  @ApiProperty({
    example: { active: 12, completed: 4, delinquent: 2, cancelled: 1 },
    description: 'Cantidad de planes por estado',
  })
  plansByStatus: Record<PaymentPlanStatus, number>;
}
