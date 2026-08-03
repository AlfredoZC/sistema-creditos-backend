import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditModule } from '../audit/audit.module';
import { DoctorsModule } from '../doctors/doctors.module';
import { PatientsModule } from '../patients/patients.module';
import { SurgeryCatalogModule } from '../surgery-catalog/surgery-catalog.module';
import { Surgery, SurgeryDoctor } from './entities';
import { SurgeriesController } from './surgeries.controller';
import { SurgeriesService } from './surgeries.service';

@Module({
  controllers: [SurgeriesController],
  providers: [SurgeriesService],
  imports: [
    TypeOrmModule.forFeature([Surgery, SurgeryDoctor]),
    PatientsModule,
    DoctorsModule,
    SurgeryCatalogModule,
    AuditModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  exports: [TypeOrmModule, SurgeriesService],
})
export class SurgeriesModule {}
