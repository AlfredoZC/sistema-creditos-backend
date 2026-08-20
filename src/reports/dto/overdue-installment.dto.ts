import { ApiProperty } from '@nestjs/swagger';

/**
 * Una cuota vencida con el paciente detras, para que cobranza pueda llamar sin
 * tener que abrir el plan. No incluye datos financieros del plan completo: lo
 * que se necesita para gestionar es a quien llamar y cuanto reclamar.
 */
export class OverdueInstallmentDto {
  @ApiProperty()
  installmentId: string;

  @ApiProperty()
  planId: string;

  @ApiProperty()
  patientId: string;

  @ApiProperty({ example: 'Rosa Quispe Mamani' })
  patientName: string;

  @ApiProperty({ example: '+59171234567' })
  patientPhone: string;

  @ApiProperty({ example: 2 })
  installmentNumber: number;

  @ApiProperty({ example: '2026-07-15' })
  dueDate: string;

  @ApiProperty({
    example: '180.00',
    description: 'Saldo de la cuota: total menos lo ya pagado',
  })
  amountDue: string;

  @ApiProperty({ example: 36 })
  daysOverdue: number;
}
