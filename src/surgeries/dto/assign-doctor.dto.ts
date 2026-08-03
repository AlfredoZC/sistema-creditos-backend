import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { SurgeryDoctorRole } from '../../common/enums';

export class AssignDoctorDto {
  @IsUUID()
  doctorId: string;

  // Defaults to 'principal' in the migration when omitted.
  @IsOptional()
  @IsEnum(SurgeryDoctorRole)
  role?: SurgeryDoctorRole;
}
