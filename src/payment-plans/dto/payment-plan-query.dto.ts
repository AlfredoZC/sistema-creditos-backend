import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { PaymentPlanStatus } from '../../common/enums';
import { PaginationDto } from '../../common/dtos/pagination.dto';

/**
 * AD8 (design section 5): staff-only list filters on top of the shared
 * pagination envelope. Non-staff callers may send them but the service
 * applies the in-memory own-scope regardless (AD9).
 */
export class PaymentPlanQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  patientId?: string;

  @IsOptional()
  @IsUUID()
  surgeryId?: string;

  @IsOptional()
  @IsEnum(PaymentPlanStatus)
  status?: PaymentPlanStatus;
}
