import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SurgeryCatalog } from './entities/surgery-catalog.entity';
import { SurgeryCatalogController } from './surgery-catalog.controller';
import { SurgeryCatalogService } from './surgery-catalog.service';

@Module({
  controllers: [SurgeryCatalogController],
  providers: [SurgeryCatalogService],
  imports: [
    TypeOrmModule.forFeature([SurgeryCatalog]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
  ],
  exports: [TypeOrmModule, SurgeryCatalogService],
})
export class SurgeryCatalogModule {}
