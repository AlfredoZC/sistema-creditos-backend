import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { Patient } from '../patients/entities/patient.entity';
import { PaymentMethod } from '../payment-methods/entities/payment-method.entity';
import { Installment, PaymentPlan } from '../payment-plans/entities';
import { PaymentPlansModule } from '../payment-plans/payment-plans.module';
import { Surgery } from '../surgeries/entities/surgery.entity';
import { Payment } from './entities';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService],
  imports: [
    TypeOrmModule.forFeature([
      Payment,
      PaymentPlan,
      Installment,
      PaymentMethod,
      Surgery,
      Patient,
    ]),
    // AD4: the module imports payment-plans only for the exported
    // RecalculationStrategyFactory (re-registering it here is forbidden).
    AuditModule,
    PaymentPlansModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
})
export class PaymentsModule {}
