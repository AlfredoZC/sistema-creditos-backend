import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { handleDatabaseError } from '../common/errors';
import { CreateSurgeryCatalogDto } from './dto/create-surgery-catalog.dto';
import { UpdateSurgeryCatalogDto } from './dto/update-surgery-catalog.dto';
import { SurgeryCatalog } from './entities/surgery-catalog.entity';

@Injectable()
export class SurgeryCatalogService {
  constructor(
    @InjectRepository(SurgeryCatalog)
    private readonly surgeryCatalogRepository: Repository<SurgeryCatalog>,
  ) {}

  /**
   * Duplicate catalog names surface as 409. The migration has no UNIQUE
   * constraint on surgery_catalog.name, so PG 23505 can never fire: the
   * conflict is enforced here with an explicit pre-check (same outcome,
   * locked decision: duplicate name -> 409).
   */
  async create(
    createSurgeryCatalogDto: CreateSurgeryCatalogDto,
  ): Promise<SurgeryCatalog> {
    try {
      await this.assertUniqueName(createSurgeryCatalogDto.name);
      const entry = this.surgeryCatalogRepository.create(
        createSurgeryCatalogDto,
      );
      return await this.surgeryCatalogRepository.save(entry);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  async findAll(paginationDto: PaginationDto) {
    const { limit = 10, offset = 0 } = paginationDto;
    const [data, total] = await this.surgeryCatalogRepository.findAndCount({
      take: limit,
      skip: offset,
    });
    return { data, total, limit, offset };
  }

  async findOne(id: string): Promise<SurgeryCatalog> {
    const entry = await this.surgeryCatalogRepository.findOne({
      where: { id },
    });
    if (!entry) throw new NotFoundException('Catalog entry not found');
    return entry;
  }

  async update(
    id: string,
    updateSurgeryCatalogDto: UpdateSurgeryCatalogDto,
  ): Promise<SurgeryCatalog> {
    try {
      const entry = await this.surgeryCatalogRepository.findOne({
        where: { id },
      });
      if (!entry) throw new NotFoundException('Catalog entry not found');
      if (
        updateSurgeryCatalogDto.name &&
        updateSurgeryCatalogDto.name !== entry.name
      ) {
        await this.assertUniqueName(updateSurgeryCatalogDto.name);
      }
      Object.assign(entry, updateSurgeryCatalogDto);
      return await this.surgeryCatalogRepository.save(entry);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      handleDatabaseError(error);
    }
  }

  private async assertUniqueName(name: string): Promise<void> {
    const existing = await this.surgeryCatalogRepository.findOne({
      where: { name },
    });
    if (existing) {
      throw new ConflictException(
        'A catalog entry with this name already exists',
      );
    }
  }
}
