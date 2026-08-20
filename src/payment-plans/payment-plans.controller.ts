import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth, GetUser } from '../auth/decorators';
import { User } from '../auth/entities/user.entity';
import { UserRole } from '../common/enums';
import {
  CancelPaymentPlanDto,
  CreatePaymentPlanDto,
  PaymentPlanQueryDto,
} from './dto';
import { PaymentPlansService } from './payment-plans.service';

@ApiTags('Payment Plans')
@Controller('payment-plans')
export class PaymentPlansController {
  constructor(private readonly paymentPlansService: PaymentPlansService) {}

  // T1 (design section 8.1): plan + schedule + down payment + audit in ONE
  // transaction. Office and admin only — patients never create plans.
  @Post()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 201, description: 'Payment plan created' })
  @ApiResponse({
    status: 409,
    description:
      'A plan already exists for this surgery, or the payment method is disabled',
  })
  create(
    @Body() createPaymentPlanDto: CreatePaymentPlanDto,
    @GetUser() user: User,
  ) {
    return this.paymentPlansService.create(createPaymentPlanDto, user);
  }

  // AD8/AD9 (design section 5): any authenticated user; staff get the full
  // paginated list with filters, patients only their own plans (in-memory).
  @Get()
  @Auth()
  @ApiResponse({ status: 200, description: 'Paginated payment plan list' })
  findAll(@Query() query: PaymentPlanQueryDto, @GetUser() user: User) {
    return this.paymentPlansService.findAll(query, user);
  }

  @Get(':id')
  @Auth()
  @ApiResponse({ status: 200, description: 'Payment plan detail' })
  @ApiResponse({
    status: 403,
    description: 'Patients can only access their own payment plans',
  })
  findOne(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.paymentPlansService.findOne(id, user);
  }

  // Installments with the derived overdue flag; read-only, never a write.
  @Get(':id/installments')
  @Auth()
  @ApiResponse({ status: 200, description: 'Installments with overdue flag' })
  @ApiResponse({
    status: 403,
    description: 'Patients can only access their own payment plans',
  })
  findInstallments(
    @Param('id', ParseUUIDPipe) id: string,
    @GetUser() user: User,
  ) {
    return this.paymentPlansService.findInstallments(id, user);
  }

  /**
   * Anula el plan: la deuda deja de cobrarse. Es una decision administrativa e
   * irreversible, asi que queda para office/admin y exige motivo.
   */
  @Post(':id/cancel')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiResponse({ status: 200, description: 'Plan anulado y auditado' })
  @ApiResponse({
    status: 409,
    description: 'El plan ya estaba anulado, o ya fue pagado',
  })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() cancelPaymentPlanDto: CancelPaymentPlanDto,
    @GetUser() user: User,
  ) {
    return this.paymentPlansService.cancel(id, cancelPaymentPlanDto, user);
  }
}
