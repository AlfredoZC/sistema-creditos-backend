import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsObject, IsUUID } from 'class-validator';

/**
 * Dispatch payload (design §9.2, task 3.3): patient + template + resolved
 * variables. The variables map MUST mirror the template's contiguous
 * `{{1}}..{{N}}` placeholders — the service enforces the 1:1 match with 400
 * (spec "Placeholder mismatch rejected") after whitelist validation here
 * (IsUUID x2, IsObject, forbidNonWhitelisted via the global pipe).
 */
export class CreateDispatchDto {
  @ApiProperty({ example: '00000000-0000-4000-8000-000000000000' })
  @IsUUID()
  patientId: string;

  @ApiProperty({ example: '00000000-0000-4000-8000-000000000000' })
  @IsUUID()
  templateId: string;

  @ApiProperty({
    type: Object,
    example: { '1': 'Juan', '2': 'Bs 8155.19', '3': '2026-08-05' },
  })
  @IsObject()
  @IsNotEmpty()
  variables: Record<string, string>;
}
