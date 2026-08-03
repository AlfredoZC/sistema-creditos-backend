import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { UserRole } from '../common/enums';
import { CreateSurgeryCatalogDto, UpdateSurgeryCatalogDto } from './dto';
import { SurgeryCatalogService } from './surgery-catalog.service';

@ApiTags('Surgery Catalog')
@Controller('surgery-catalog')
export class SurgeryCatalogController {
  constructor(
    private readonly surgeryCatalogService: SurgeryCatalogService,
  ) {}

  @Post()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 201, description: 'Catalog entry was created' })
  @ApiResponse({
    status: 409,
    description: 'A catalog entry with this name already exists',
  })
  create(@Body() createSurgeryCatalogDto: CreateSurgeryCatalogDto) {
    return this.surgeryCatalogService.create(createSurgeryCatalogDto);
  }

  // Read-only for every authenticated role (design section 11): the catalog
  // is the reference price list, visible to patients and doctors alike.
  @Get()
  @Auth()
  @ApiResponse({ status: 200, description: 'Paginated catalog entry list' })
  findAll(@Query() paginationDto: PaginationDto) {
    return this.surgeryCatalogService.findAll(paginationDto);
  }

  @Get(':id')
  @Auth()
  @ApiResponse({ status: 200, description: 'Catalog entry found' })
  @ApiResponse({ status: 404, description: 'Catalog entry not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.surgeryCatalogService.findOne(id);
  }

  @Patch(':id')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Catalog entry updated' })
  @ApiResponse({
    status: 409,
    description: 'A catalog entry with this name already exists',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateSurgeryCatalogDto: UpdateSurgeryCatalogDto,
  ) {
    return this.surgeryCatalogService.update(id, updateSurgeryCatalogDto);
  }
}
