import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth, GetUser } from '../auth/decorators';
import { User } from '../auth/entities/user.entity';
import { DispatchStatus, UserRole } from '../common/enums';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { CreateDispatchDto } from './dto';
import { DispatchesService } from './dispatches.service';

/**
 * Dispatch trigger + status tracking endpoints (design §9.2). Office/admin
 * only — a patient role is rejected by the role guard with 403 before
 * reaching any handler. The list mirrors the doctors/patients PaginationDto
 * envelope ({ data, total, limit, offset }) plus an optional dispatch_status
 * filter; the retry endpoint follows the payments POST-action convention
 * (@HttpCode 200 — it re-routes an existing dispatch, it does not create).
 */
@ApiTags('WhatsApp Dispatches')
@Controller('whatsapp/dispatches')
export class DispatchesController {
  constructor(private readonly dispatchesService: DispatchesService) {}

  @Post()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 201, description: 'Dispatch created and sent' })
  @ApiResponse({
    status: 409,
    description: 'Duplicate dispatch or non-dispatchable template',
  })
  create(@Body() createDispatchDto: CreateDispatchDto, @GetUser() user: User) {
    return this.dispatchesService.create(createDispatchDto, user.id);
  }

  @Post(':id/retry')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiResponse({ status: 200, description: 'Dispatch re-routed and re-sent' })
  @ApiResponse({
    status: 409,
    description: 'Terminal status or send attempt limit reached',
  })
  retry(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.dispatchesService.retry(id, user.id);
  }

  @Get()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({
    status: 200,
    description: 'Paginated dispatch list with status filter',
  })
  findAll(
    @Query('status', new ParseEnumPipe(DispatchStatus, { optional: true }))
    status?: DispatchStatus,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
  ) {
    // Keyed queries only: an unkeyed @Query() PaginationDto would capture the
    // whole query object (including `status`) and the global whitelist pipe
    // would reject it. The range guards below reproduce PaginationDto's
    // IsPositive/Min(0) contract for the raw ParseIntPipe values.
    if (limit !== undefined && limit <= 0) {
      throw new BadRequestException('limit must be a positive number');
    }
    if (offset !== undefined && offset < 0) {
      throw new BadRequestException('offset must be zero or a positive number');
    }
    const pagination: PaginationDto = { limit, offset };
    return this.dispatchesService.findAll({ status }, pagination);
  }

  @Get(':id')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Dispatch detail' })
  @ApiResponse({ status: 404, description: 'Dispatch not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.dispatchesService.findOne(id);
  }
}
