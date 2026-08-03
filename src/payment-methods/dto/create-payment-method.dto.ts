import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePaymentMethodDto {
  @IsString()
  @MaxLength(50)
  name: string;

  // Omitted -> true (the migration DDL default); office/admin pass false to
  // retire a method without deleting it (payments then get 409 on use).
  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsString()
  description?: string;
}
