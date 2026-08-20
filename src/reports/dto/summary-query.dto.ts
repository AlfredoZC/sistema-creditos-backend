import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';

/**
 * Rango de fechas del resumen. Ambos extremos son inclusivos y se interpretan
 * como fechas de calendario del servidor (no instantes UTC), igual que la
 * columna `due_date`. Si no se envian, el rango por defecto es el mes en curso.
 */
export class SummaryQueryDto {
  @ApiPropertyOptional({ example: '2026-08-01' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}
