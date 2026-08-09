import { IsOptional, IsString, MaxLength } from 'class-validator';

// Deliberately NOT PartialType(CreateDoctorDto): the update endpoint only
// manages doctor profile fields. Account fields (name, email, password,
// userId) belong to the auth module and must not be patchable here.
export class UpdateDoctorDto {
  @IsOptional()
  @IsString()
  specialty?: string;

  @IsOptional()
  @IsString()
  professionalLicense?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  paternalLastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  maternalLastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;
}
