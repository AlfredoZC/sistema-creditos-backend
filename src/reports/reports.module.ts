import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService],
  // PassportModule es obligatorio para que el @Auth del controlador resuelva
  // la estrategia jwt; sin el, el guard responde 500 en vez de 401.
  imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
})
export class ReportsModule {}
