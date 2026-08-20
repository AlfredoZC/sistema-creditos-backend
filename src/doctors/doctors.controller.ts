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
import { Auth, GetUser } from '../auth/decorators';
import { User } from '../auth/entities/user.entity';
import { UserRole } from '../common/enums';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { CreateDoctorDto, UpdateDoctorDto } from './dto';
import { DoctorsService } from './doctors.service';

@ApiTags('Doctors')
@Controller('doctors')
export class DoctorsController {
  constructor(private readonly doctorsService: DoctorsService) {}

  @Post()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({
    status: 201,
    description: 'Doctor was created with its web account',
  })
  @ApiResponse({ status: 409, description: 'Duplicate professional license' })
  create(@Body() createDoctorDto: CreateDoctorDto) {
    return this.doctorsService.create(createDoctorDto);
  }

  @Get()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Paginated doctor list' })
  findAll(@Query() paginationDto: PaginationDto) {
    return this.doctorsService.findAll(paginationDto);
  }

  @Get(':id')
  @Auth(UserRole.DOCTOR, UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Doctor found' })
  @ApiResponse({
    status: 403,
    description: 'Doctors can only read their own record',
  })
  findOne(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.doctorsService.findOne(id, user);
  }

  @Patch(':id')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Doctor updated' })
  @ApiResponse({ status: 409, description: 'Duplicate professional license' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateDoctorDto: UpdateDoctorDto,
    @GetUser() user: User,
  ) {
    return this.doctorsService.update(id, updateDoctorDto, user);
  }
}
