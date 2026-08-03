import {
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateDoctorDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  // Account fields are only validated when no existing user is linked: the
  // doctor's web account is created atomically with the doctor row (T8).
  @ValidateIf((dto: CreateDoctorDto) => !dto.userId)
  @IsString()
  @MaxLength(50)
  name?: string;

  @ValidateIf((dto: CreateDoctorDto) => !dto.userId)
  @IsString()
  @IsEmail()
  @MaxLength(255)
  email?: string;

  @ValidateIf((dto: CreateDoctorDto) => !dto.userId)
  @IsString()
  @MinLength(6)
  @MaxLength(50)
  @Matches(/(?:(?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/, {
    message:
      'The password must have an Uppercase, lowercase letter and a number',
  })
  password?: string;

  @IsString()
  specialty: string;

  @IsString()
  professionalLicense: string;
}
