import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { PaymentPlansModule } from '../payment-plans/payment-plans.module';
import { MessageTemplate } from './entities';
import { createProvider } from './provider/whatsapp-provider.factory';
import { TemplatesService } from './templates/templates.service';

/**
 * Injection token for the WhatsApp provider port (design AD1). The factory
 * (design §7) selects MockWhatsAppProvider or MetaCloudApiProvider from
 * WHATSAPP_PROVIDER and fails fast on unknown values; with 'mock' the Meta
 * adapter is never constructed (spec "Mock provider isolation").
 */
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');

/**
 * WhatsApp feature module (design §3). Hosts the template lifecycle
 * (TemplatesService) and, in later slices, dispatch/webhook/bot services and
 * controllers. Imports PaymentPlansModule so the bot's patient-scoped debt
 * read is reachable without module cycles (design §10).
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([MessageTemplate]),
    AuditModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    PaymentPlansModule,
  ],
  providers: [
    TemplatesService,
    {
      provide: WHATSAPP_PROVIDER,
      useFactory: createProvider,
      inject: [ConfigService],
    },
  ],
  exports: [TypeOrmModule, WHATSAPP_PROVIDER, TemplatesService],
})
export class WhatsappModule {}
