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
import { CreatePatientDto, LinkUserDto, UpdatePatientDto } from './dto';
import { PatientsService } from './patients.service';

@ApiTags('Patients')
@Controller('patients')
export class PatientsController {
  constructor(private readonly patientsService: PatientsService) {}

  @Post()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 201, description: 'Patient was created' })
  @ApiResponse({
    status: 409,
    description: 'Duplicate phone or identity document',
  })
  create(@Body() createPatientDto: CreatePatientDto) {
    return this.patientsService.create(createPatientDto);
  }

  @Get()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Paginated patient list' })
  findAll(@Query() paginationDto: PaginationDto) {
    return this.patientsService.findAll(paginationDto);
  }

  @Get(':id')
  @Auth()
  @ApiResponse({ status: 200, description: 'Patient found' })
  @ApiResponse({
    status: 403,
    description: 'Patients can only read their own record',
  })
  findOne(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.patientsService.findOne(id, user);
  }

  @Patch(':id')
  @Auth()
  @ApiResponse({ status: 200, description: 'Patient updated' })
  @ApiResponse({
    status: 403,
    description: 'Patients can only update their own record',
  })
  @ApiResponse({
    status: 409,
    description: 'Duplicate phone or identity document',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updatePatientDto: UpdatePatientDto,
    @GetUser() user: User,
  ) {
    return this.patientsService.update(id, updatePatientDto, user);
  }

  @Post(':id/link-user')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 201, description: 'User linked to patient' })
  @ApiResponse({ status: 409, description: 'Patient or user already linked' })
  linkUser(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() linkUserDto: LinkUserDto,
  ) {
    return this.patientsService.linkUser(id, linkUserDto);
  }
}
