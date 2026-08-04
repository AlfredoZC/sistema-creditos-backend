import { Body, Controller, Post } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth, GetUser } from '../auth/decorators';
import { User } from '../auth/entities/user.entity';
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
  register(
    @Body() createPaymentDto: CreatePaymentDto,
    @GetUser() user: User,
  ) {
    return this.paymentsService.register(createPaymentDto, user);
  }
}
