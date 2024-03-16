import { Module } from '@nestjs/common';
import { ProfileService } from './profile.service';
import { ProfileController } from './profile.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Profile } from './entities/profile.entity';
import { CloudinaryService } from 'src/cloudinary/cloudinary.service';
import { ConfigService } from '@nestjs/config';

@Module({
  controllers: [ProfileController],
  providers: [ProfileService, CloudinaryService, ConfigService],
  imports: [TypeOrmModule.forFeature([Profile])],
  exports: [TypeOrmModule],
})
export class ProfileModule {}
