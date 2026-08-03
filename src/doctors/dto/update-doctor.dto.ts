import { IsOptional, IsString } from 'class-validator';

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
}
