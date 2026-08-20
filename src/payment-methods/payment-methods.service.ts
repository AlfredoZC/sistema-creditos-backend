import { HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { handleDatabaseError } from '../common/errors';
import { CreatePaymentMethodDto } from './dto/create-payment-method.dto';
import { UpdatePaymentMethodDto } from './dto/update-payment-method.dto';
import { PaymentMethod } from './entities/payment-method.entity';

@Injectable()
export class PaymentMethodsService {
  constructor(
    @InjectRepository(PaymentMethod)
    private readonly paymentMethodRepository: Repository<PaymentMethod>,
  ) {}

  /**
   * Duplicate names surface as 409 through the shared handler: the migration
   * declares uq_payment_methods_name UNIQUE, so PG 23505 fires on the insert.
   */
  async create(
    createPaymentMethodDto: CreatePaymentMethodDto,
  ): Promise<PaymentMethod> {
    try {
      const method = this.paymentMethodRepository.create({
        name: createPaymentMethodDto.name,
        isEnabled: createPaymentMethodDto.isEnabled ?? true,
        description: createPaymentMethodDto.description ?? null,
      });
      return await this.paymentMethodRepository.save(method);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  /**
   * Read side of the payment methods catalog: enabled only (design section
   * 11), so disabled methods are never offered to payment registration.
   */
  async findAll(): Promise<PaymentMethod[]> {
    return this.paymentMethodRepository.find({ where: { isEnabled: true } });
  }

  async findOne(id: string): Promise<PaymentMethod> {
    const method = await this.paymentMethodRepository.findOne({
      where: { id },
    });
    if (!method) throw new NotFoundException('Payment method not found');
    return method;
  }

  async update(
    id: string,
    updatePaymentMethodDto: UpdatePaymentMethodDto,
  ): Promise<PaymentMethod> {
    try {
      const method = await this.findOne(id);
      Object.assign(method, updatePaymentMethodDto);
      return await this.paymentMethodRepository.save(method);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }
}
