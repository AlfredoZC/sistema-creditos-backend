import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { PaymentPlanType } from '../../common/enums';
import { IsMoney } from '../../common/validators';

/**
 * T1 create-plan payload (design sections 5.8 and 8.1). financedAmount is
 * deliberately NOT accepted: it is derived by the service as
 * surgery.total_cost - down_payment, so the plan can never desync from the
 * priced surgery (design D2 guard).
 */
export class CreatePaymentPlanDto {
  @ApiProperty()
  @IsUUID()
  surgeryId: string;

  @ApiProperty({ enum: PaymentPlanType })
  @IsEnum(PaymentPlanType)
  type: PaymentPlanType;

  @ApiPropertyOptional({ default: '0.00' })
  @IsOptional()
  @IsString()
  @IsMoney()
  downPayment?: string;

  @ApiPropertyOptional({ default: '2.00' })
  @IsOptional()
  @IsString()
  @IsMoney()
  monthlyInterestRate?: string;

  // Forced to 1 for upfront plans by the service; required for credit plans.
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  installmentCount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  startDate?: string;

  // Required by the service whenever downPayment > 0 (the down payment is
  // registered as an auto-confirmed payment in the same transaction).
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  paymentMethodId?: string;
}
