import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthModule } from './auth/auth.module';
import { AuditModule } from './audit/audit.module';
import { CommonModule } from './common/common.module';
import { DoctorsModule } from './doctors/doctors.module';
import { PatientsModule } from './patients/patients.module';
import { PaymentMethodsModule } from './payment-methods/payment-methods.module';
import { PaymentPlansModule } from './payment-plans/payment-plans.module';
import { PaymentsModule } from './payments/payments.module';
import { SeedModule } from './seed/seed.module';
import { SurgeryCatalogModule } from './surgery-catalog/surgery-catalog.module';
import { SurgeriesModule } from './surgeries/surgeries.module';
import { ProfileModule } from './profile/profile.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';

@Module({
  imports: [
    ConfigModule.forRoot(),
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: +process.env.DB_PORT,
      database: process.env.DB_NAME,
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      autoLoadEntities: true,
      // Schema changes are handled EXCLUSIVELY through migrations
      // (src/database/migrations). synchronize applies schema changes without
      // versioning, review, or rollback — unsafe for production and cloud deploys.
      synchronize: false,
      // Migrations run manually with npm run migration:run (Laravel-style);
      // they are never auto-applied at startup. The timestamped glob keeps
      // non-migration files (e.g. migration specs) out of TypeORM's loader.
      migrationsRun: false,
      migrations: [__dirname + '/database/migrations/[0-9]*{.ts,.js}'],
    }),
    AuthModule,
    CommonModule,
    AuditModule,
    PatientsModule,
    DoctorsModule,
    SurgeryCatalogModule,
    SurgeriesModule,
    PaymentMethodsModule,
    PaymentPlansModule,
    PaymentsModule,
    SeedModule,
    ProfileModule,
    CloudinaryModule,
  ],
})
export class AppModule {}
