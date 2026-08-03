import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePatientDto {
  @IsString()
  @MaxLength(20)
  identityDocument: string;

  @IsString()
  @MaxLength(50)
  firstName: string;

  @IsString()
  @MaxLength(50)
  paternalLastName: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  maternalLastName?: string;

  @IsOptional()
  @IsDateString()
  birthDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  address?: string;

  @IsString()
  @MaxLength(50)
  phone: string;
}
