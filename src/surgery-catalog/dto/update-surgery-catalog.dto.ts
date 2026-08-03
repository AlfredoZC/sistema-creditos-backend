import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsMoney } from '../../common/validators';

export class UpdateSurgeryCatalogDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsMoney()
  baseCost?: string;
}
