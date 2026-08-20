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
import {
  AssignDoctorDto,
  CreateSurgeryDto,
  ReassignPrincipalDto,
  UpdateSurgeryDto,
  UpdateSurgeryNotesDto,
  UpdateSurgeryStatusDto,
} from './dto';
import { SurgeriesService } from './surgeries.service';

@ApiTags('Surgeries')
@Controller('surgeries')
export class SurgeriesController {
  constructor(private readonly surgeriesService: SurgeriesService) {}

  @Post()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 201, description: 'Surgery was scheduled' })
  @ApiResponse({
    status: 404,
    description: 'Patient or catalog entry not found',
  })
  create(@Body() createSurgeryDto: CreateSurgeryDto) {
    return this.surgeriesService.create(createSurgeryDto);
  }

  // Abierto a cualquier autenticado: el servicio recorta el resultado segun el
  // rol (paciente -> las suyas, doctor -> donde esta asignado, staff -> todas).
  @Get()
  @Auth()
  @ApiResponse({ status: 200, description: 'Paginated surgery list' })
  findAll(@Query() paginationDto: PaginationDto, @GetUser() user: User) {
    return this.surgeriesService.findAll(paginationDto, user);
  }

  @Get(':id')
  @Auth()
  @ApiResponse({ status: 200, description: 'Surgery detail' })
  @ApiResponse({
    status: 403,
    description:
      'Patients and doctors can only access surgeries that belong to them',
  })
  findOne(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.surgeriesService.findOne(id, user);
  }

  @Patch(':id')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Surgery updated' })
  @ApiResponse({
    status: 409,
    description: 'total_cost cannot change once a payment plan exists',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateSurgeryDto: UpdateSurgeryDto,
  ) {
    return this.surgeriesService.update(id, updateSurgeryDto);
  }

  // El medico entra aca tambien: el servicio lo limita a marcar como realizada
  // la cirugia que encabeza como principal.
  @Patch(':id/status')
  @Auth(UserRole.DOCTOR, UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({
    status: 200,
    description: 'Surgery status updated and audited',
  })
  @ApiResponse({ status: 400, description: 'Invalid status value' })
  @ApiResponse({
    status: 403,
    description:
      'A doctor can only mark as performed a surgery they lead as principal',
  })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateSurgeryStatusDto: UpdateSurgeryStatusDto,
    @GetUser() user: User,
  ) {
    return this.surgeriesService.updateStatus(id, updateSurgeryStatusDto, user);
  }

  // Nota quirurgica: la escribe el cirujano principal o el staff. Va aparte del
  // PATCH general porque aquel permite tocar el costo total.
  @Patch(':id/notes')
  @Auth(UserRole.DOCTOR, UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Surgical note saved and audited' })
  @ApiResponse({
    status: 403,
    description: 'Only the principal surgeon or the staff can write the note',
  })
  updateNotes(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateSurgeryNotesDto: UpdateSurgeryNotesDto,
    @GetUser() user: User,
  ) {
    return this.surgeriesService.updateNotes(id, updateSurgeryNotesDto, user);
  }

  @Post(':id/doctors')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 201, description: 'Doctor assigned to the surgery' })
  @ApiResponse({
    status: 409,
    description: 'Doctor already assigned, or surgery already has a principal',
  })
  assignDoctor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() assignDoctorDto: AssignDoctorDto,
  ) {
    return this.surgeriesService.assignDoctor(id, assignDoctorDto);
  }

  @Post(':id/doctors/reassign-principal')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 201, description: 'Principal doctor reassigned' })
  @ApiResponse({
    status: 409,
    description: 'Doctor is already the principal of this surgery',
  })
  reassignPrincipal(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() reassignPrincipalDto: ReassignPrincipalDto,
  ) {
    return this.surgeriesService.reassignPrincipal(id, reassignPrincipalDto);
  }
}
