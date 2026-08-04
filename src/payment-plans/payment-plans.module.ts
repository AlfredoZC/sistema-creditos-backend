import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { PaymentMethod } from '../payment-methods/entities/payment-method.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Surgery } from '../surgeries/entities/surgery.entity';
import { Installment, PaymentPlan } from './entities';
import { FinancingEngine } from './financing/financing-engine';
import { PaymentPlansController } from './payment-plans.controller';
import { PaymentPlansService } from './payment-plans.service';
import { RecalculationStrategyFactory } from './strategies';

@Module({
  controllers: [PaymentPlansController],
  providers: [PaymentPlansService, FinancingEngine, RecalculationStrategyFactory],
  imports: [
    // AD4: the down-payment row is inserted through the Payment entity inside
    // the plan-creation transaction; the payments MODULE (PR13) stays out of
    // this module's dependency graph.
    TypeOrmModule.forFeature([
      PaymentPlan,
      Installment,
      Payment,
      PaymentMethod,
      Surgery,
    ]),
    AuditModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  // The recalculation factory is exported so the payments module (AD4) can
  // inject it for confirmation-time amortization recalculation (design 7).
  exports: [TypeOrmModule, PaymentPlansService, RecalculationStrategyFactory],
})
export class PaymentPlansModule {}
