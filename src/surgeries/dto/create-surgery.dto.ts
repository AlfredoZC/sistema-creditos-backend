import { IsDateString, IsOptional, IsString, IsUUID } from 'class-validator';
import { IsMoney } from '../../common/validators';

export class CreateSurgeryDto {
  @IsUUID()
  patientId: string;

  @IsUUID()
  surgeryCatalogId: string;

  @IsDateString()
  scheduledDate: string;

  // D2: optional; when omitted the service defaults total_cost to the catalog
  // entry's base_cost. When provided it overrides per-patient pricing.
  @IsOptional()
  @IsString()
  @IsMoney()
  totalCost?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
