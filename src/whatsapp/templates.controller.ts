import {
  Body,
  Controller,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { Auth, GetUser } from '../auth/decorators';
import { User } from '../auth/entities/user.entity';
import { TemplateCategory, TemplateStatus, UserRole } from '../common/enums';
import { CreateTemplateDto, UpdateTemplateDto } from './dto';
import { TemplatesService } from './templates/templates.service';

/**
 * Template lifecycle endpoints (design §9.1). Office/admin only — a patient
 * role is rejected by the role guard with 403 before reaching any handler.
 * Filters on the list mirror what TemplatesService.findAll supports
 * (status/category); create always lands `draft` and deactivation never
 * deletes the row (dispatch gate, design §9.1).
 */
@ApiTags('WhatsApp Templates')
@Controller('whatsapp/templates')
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Post()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 201, description: 'Template created as draft' })
  @ApiResponse({
    status: 409,
    description: 'Duplicate template name+language',
  })
  create(@Body() createTemplateDto: CreateTemplateDto, @GetUser() user: User) {
    return this.templatesService.create(createTemplateDto, user.id);
  }

  @Get()
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Template list with filters' })
  findAll(
    @Query('status', new ParseEnumPipe(TemplateStatus, { optional: true }))
    status?: TemplateStatus,
    @Query('category', new ParseEnumPipe(TemplateCategory, { optional: true }))
    category?: TemplateCategory,
  ) {
    return this.templatesService.findAll({ status, category });
  }

  @Get(':id')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Template detail' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.templatesService.findOne(id);
  }

  @Patch(':id')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Template updated' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  @ApiResponse({ status: 409, description: 'Disallowed status transition' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateTemplateDto: UpdateTemplateDto,
    @GetUser() user: User,
  ) {
    return this.templatesService.update(id, updateTemplateDto, user.id);
  }

  @Patch(':id/deactivate')
  @Auth(UserRole.OFFICE, UserRole.ADMIN)
  @ApiResponse({ status: 200, description: 'Template deactivated' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  deactivate(@Param('id', ParseUUIDPipe) id: string, @GetUser() user: User) {
    return this.templatesService.deactivate(id, user.id);
  }
}
