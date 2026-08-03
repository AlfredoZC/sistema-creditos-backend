import { IsDateString, IsOptional, IsString } from 'class-validator';
import { IsMoney } from '../../common/validators';

export class UpdateSurgeryDto {
  @IsOptional()
  @IsDateString()
  scheduledDate?: string;

  // Editing total_cost is rejected with 409 once a payment plan exists for the
  // surgery (D2: the plan's financed_amount derives from it and would desync).
  @IsOptional()
  @IsString()
  @IsMoney()
  totalCost?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
