import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { AmortizationMode, PaymentType } from '../../common/enums';
import { IsMoney } from '../../common/validators';

/**
 * T2/T3 registration payload (design sections 5.11 and 8.1). patientUserId is
 * deliberately NOT accepted: it is derived from the authenticated user (the
 * patient's own user on receipt upload, NULL for office counter payments).
 * Cross-field type-integrity rules (installment XOR amortization) are enforced
 * by the service so violations surface as precise 400 errors.
 */
export class CreatePaymentDto {
  @ApiProperty()
  @IsUUID()
  paymentPlanId: string;

  // Required by the service for installment_payment, forbidden for
  // down_payment and principal_amortization (type integrity rules).
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  installmentId?: string;

  @ApiProperty()
  @IsUUID()
  paymentMethodId: string;

  @ApiProperty()
  @IsString()
  @IsMoney()
  amount: string;

  @ApiProperty({ enum: PaymentType })
  @IsEnum(PaymentType)
  type: PaymentType;

  // Required by the service for principal_amortization, forbidden otherwise
  // (migration CHECK chk_payments_amortization_mode_xor).
  @ApiPropertyOptional({ enum: AmortizationMode })
  @IsOptional()
  @IsEnum(AmortizationMode)
  amortizationMode?: AmortizationMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  receiptUrl?: string;
}
