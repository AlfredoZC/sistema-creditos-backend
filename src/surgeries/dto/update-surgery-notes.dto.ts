import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/**
 * Nota quirurgica. Va en su propio endpoint y no en UpdateSurgeryDto a
 * proposito: ese DTO permite tocar el costo total, y el medico no debe poder
 * hacerlo ni por accidente.
 */
export class UpdateSurgeryNotesDto {
  @ApiProperty({ example: 'Sin complicaciones. Alta en 24 horas.' })
  @IsString()
  @MaxLength(2000)
  notes: string;
}
