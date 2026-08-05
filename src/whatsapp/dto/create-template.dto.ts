import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { TemplateCategory } from '../../common/enums';

/**
 * Create-template payload (design §9.1). Validation contract for task 2.2:
 * name 1..50 chars, language ISO 639-1 (`^[a-z]{2}$`), category from the
 * template_category enum, body 1..1024 chars (the service additionally strips
 * to 1024 at its boundary). `status` is intentionally absent — create always
 * inserts `draft` (design §9.1), the lifecycle moves it forward.
 */
export class CreateTemplateDto {
  @ApiProperty({ example: 'payment_reminder', maxLength: 50 })
  @IsString()
  @Length(1, 50)
  name: string;

  @ApiProperty({ enum: TemplateCategory })
  @IsEnum(TemplateCategory)
  category: TemplateCategory;

  @ApiProperty({ example: 'es' })
  @IsString()
  @Matches(/^[a-z]{2}$/, { message: 'language must be an ISO 639-1 code' })
  language: string;

  @ApiProperty({
    example: 'Hola {{1}}, tu pago de {{2}} vence el {{3}}.',
    maxLength: 1024,
  })
  @IsString()
  @Length(1, 1024)
  body: string;

  @ApiPropertyOptional({
    type: Object,
    example: { '1': 'Juan', '2': 'Bs 8155.19', '3': '2026-08-05' },
  })
  @IsOptional()
  @IsObject()
  sampleVariables?: Record<string, string>;
}
