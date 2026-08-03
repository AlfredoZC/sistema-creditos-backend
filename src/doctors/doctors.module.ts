import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DoctorsController } from './doctors.controller';
import { DoctorsService } from './doctors.service';
import { Doctor } from './entities/doctor.entity';

@Module({
  controllers: [DoctorsController],
  providers: [DoctorsService],
  imports: [
    TypeOrmModule.forFeature([Doctor]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  exports: [TypeOrmModule, DoctorsService],
})
export class DoctorsModule {}
