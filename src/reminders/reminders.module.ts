import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsappModule } from '../whatsapp/whatsapp.module';
import { InstallmentReminder } from './entities/installment-reminder.entity';
import { RemindersController } from './reminders.controller';
import { RemindersScheduler } from './reminders.scheduler';
import { RemindersService } from './reminders.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([InstallmentReminder]),
    // ConfigModule no es global en este proyecto: hay que importarlo para
    // inyectar ConfigService (nombres de plantilla configurables).
    ConfigModule,
    ScheduleModule.forRoot(),
    WhatsappModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  controllers: [RemindersController],
  providers: [RemindersService, RemindersScheduler],
  exports: [RemindersService],
})
export class RemindersModule {}
