import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth, GetUser } from '../auth/decorators';
import { User } from '../auth/entities/user.entity';
import { UserRole } from '../common/enums';
import { CreatePaymentDto } from './dto';
import { PaymentsService } from './payments.service';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // T2/T3 (design section 8.1): office/admin registrations auto-confirm in
  // the same transaction; patient receipt uploads stay pending_confirmation.
  @Post()
  @Auth()
  @ApiResponse({ status: 201, description: 'Payment registered' })
  @ApiResponse({
    status: 409,
    description:
      'Payment method disabled, overpayment, or amortization above the outstanding balance',
  })
  register(@Body() createPaymentDto: CreatePaymentDto, @GetUser() user: User) {
    return this.paymentsService.register(createPaymentDto, user);
  }

  // T4 (design section 8.2): office/admin confirm a pending payment; money
  // movement, recalculation and audit all run in ONE transaction.
  @Post(':id/confirm')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiResponse({ status: 200, description: 'Payment confirmed' })
  @ApiResponse({ status: 409, description: 'Terminal state or conflict' })
  confirm(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.paymentsService.confirm(id, user);
  }

  // T5 (design section 8.1): office/admin reject a pending payment; the
  // rejection is side-effect free.
  @Post(':id/reject')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiResponse({ status: 200, description: 'Payment rejected' })
  @ApiResponse({ status: 409, description: 'Terminal state' })
  reject(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.paymentsService.reject(id, user);
  }

  // Payment history (design section 11): office/admin any payment, patient
  // own plan only.
  @Get()
  @Auth()
  @ApiResponse({ status: 200, description: 'Payment history' })
  findAll(@GetUser() user: User) {
    return this.paymentsService.findAll(user);
  }
}
