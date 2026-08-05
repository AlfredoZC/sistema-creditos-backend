import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { TemplateCategory, TemplateStatus } from '../../common/enums';

/**
 * Update-template payload (PATCH semantics, design §9.1): every field is
 * optional and only provided fields are applied. `status` follows the
 * immutable transition map enforced by TemplatesService
 * (draft→submitted|rejected; submitted→approved|rejected; approved→rejected;
 * rejected→draft|submitted).
 */
export class UpdateTemplateDto {
  @ApiPropertyOptional({ maxLength: 50 })
  @IsOptional()
  @IsString()
  @Length(1, 50)
  name?: string;

  @ApiPropertyOptional({ enum: TemplateCategory })
  @IsOptional()
  @IsEnum(TemplateCategory)
  category?: TemplateCategory;

  @ApiPropertyOptional({ example: 'es' })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2}$/, { message: 'language must be an ISO 639-1 code' })
  language?: string;

  @ApiPropertyOptional({ maxLength: 1024 })
  @IsOptional()
  @IsString()
  @Length(1, 1024)
  body?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  sampleVariables?: Record<string, string>;

  @ApiPropertyOptional({ enum: TemplateStatus })
  @IsOptional()
  @IsEnum(TemplateStatus)
  status?: TemplateStatus;
}
