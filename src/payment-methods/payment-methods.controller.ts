import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators';
import { UserRole } from '../common/enums';
import { CreatePaymentMethodDto, UpdatePaymentMethodDto } from './dto';
import { PaymentMethodsService } from './payment-methods.service';

@ApiTags('Payment Methods')
@Controller('payment-methods')
export class PaymentMethodsController {
  constructor(private readonly paymentMethodsService: PaymentMethodsService) {}

  @Post()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 201, description: 'Payment method was created' })
  @ApiResponse({
    status: 409,
    description: 'A payment method with this name already exists',
  })
  create(@Body() createPaymentMethodDto: CreatePaymentMethodDto) {
    return this.paymentMethodsService.create(createPaymentMethodDto);
  }

  // Read side for every authenticated role (design section 11): the enabled
  // catalog is the offer list for payment registration, patient-facing too.
  @Get()
  @Auth()
  @ApiResponse({ status: 200, description: 'Enabled payment method list' })
  findAll() {
    return this.paymentMethodsService.findAll();
  }

  @Patch(':id')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Payment method updated' })
  @ApiResponse({
    status: 409,
    description: 'A payment method with this name already exists',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updatePaymentMethodDto: UpdatePaymentMethodDto,
  ) {
    return this.paymentMethodsService.update(id, updatePaymentMethodDto);
  }
}
