import { IsOptional, IsString, MaxLength } from 'class-validator';
import { IsMoney } from '../../common/validators';

export class CreateSurgeryCatalogDto {
  @IsString()
  @MaxLength(50)
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  // Money travels as a decimal string (design AD2); IsMoney enforces the
  // non-negative, at-most-2-decimals contract and the DB CHECK backs it up.
  @IsString()
  @IsMoney()
  baseCost: string;
}
