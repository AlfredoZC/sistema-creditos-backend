import { Module } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';
import { CloudinaryController } from './cloudinary.controller';
import { CloudinaryProvider } from './cloudinary.provider';
import { ConfigService } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';

@Module({
  controllers: [CloudinaryController],
  providers: [CloudinaryService, CloudinaryProvider, ConfigService],
  // Sin la estrategia jwt registrada, el @Auth del controlador levanta
  // "Unknown authentication strategy" y devuelve 500 en vez de 401.
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
})
export class CloudinaryModule {}
