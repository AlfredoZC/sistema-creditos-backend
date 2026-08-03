import { IsEnum } from 'class-validator';
import { SurgeryStatus } from '../../common/enums';

export class UpdateSurgeryStatusDto {
  @IsEnum(SurgeryStatus)
  status: SurgeryStatus;
}
