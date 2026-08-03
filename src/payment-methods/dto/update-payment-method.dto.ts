import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePaymentMethodDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  name?: string;

  // The is_enabled toggle: setting false retires the method (409 on use by
  // payments, hidden from the read list); setting true re-activates it.
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsString()
  description?: string;
}
