import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { PaymentPlansModule } from '../payment-plans/payment-plans.module';
import {
  BotConversation,
  BotMessage,
  MessageTemplate,
  WhatsAppDispatch,
} from './entities';
import { createProvider } from './provider/whatsapp-provider.factory';
import { BotService } from './bot.service';
import { DispatchesController } from './dispatches.controller';
import { DispatchesService } from './dispatches.service';
import { TemplatesController } from './templates.controller';
import { TemplatesService } from './templates/templates.service';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { WebhookSignatureService } from './webhook-signature.service';

// Re-exported for module-level consumers (specs, later slices); services
// inject it from the leaf token file to avoid circular imports.
export { WHATSAPP_PROVIDER } from './provider/whatsapp-provider.token';
import { WHATSAPP_PROVIDER } from './provider/whatsapp-provider.token';

/**
 * WhatsApp feature module (design §3). Hosts the template lifecycle
 * (TemplatesService + TemplatesController) and, in later slices, the
 * dispatch/webhook/bot services. Imports PaymentPlansModule so the bot's
 * patient-scoped debt read is reachable without module cycles (design §10).
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      MessageTemplate,
      WhatsAppDispatch,
      BotConversation,
      BotMessage,
    ]),
    AuditModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    PaymentPlansModule,
  ],
  controllers: [TemplatesController, DispatchesController, WebhookController],
  providers: [
    TemplatesService,
    DispatchesService,
    WebhookSignatureService,
    WebhookService,
    BotService,
    {
      provide: WHATSAPP_PROVIDER,
      useFactory: createProvider,
      inject: [ConfigService],
    },
  ],
  exports: [TypeOrmModule, WHATSAPP_PROVIDER, TemplatesService],
})
export class WhatsappModule {}
