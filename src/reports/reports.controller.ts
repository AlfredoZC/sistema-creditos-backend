import { Controller, Get, Query } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth } from '../auth/decorators';
import { PaginationDto } from '../common/dtos/pagination.dto';
import { UserRole } from '../common/enums';
import {
  OverdueInstallmentDto,
  SummaryQueryDto,
  SummaryResponseDto,
} from './dto';
import { PaginatedOverdue, ReportsService } from './reports.service';

@ApiTags('Reports')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // Solo office/admin: el resumen expone la cartera completa de la clinica.
  @Get('summary')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, type: SummaryResponseDto })
  summary(@Query() query: SummaryQueryDto): Promise<SummaryResponseDto> {
    return this.reportsService.summary(query);
  }

  // La cola de cobranza: cuotas vencidas sin saldar, la mas atrasada primero.
  @Get('overdue-installments')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, type: [OverdueInstallmentDto] })
  overdueInstallments(
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedOverdue> {
    return this.reportsService.overdueInstallments(pagination);
  }
}
