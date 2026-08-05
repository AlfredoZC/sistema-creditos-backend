import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { TemplateCategory, TemplateStatus } from '../../common/enums';
import { handleDatabaseError } from '../../common/errors';
import { CreateTemplateDto, UpdateTemplateDto } from '../dto';
import { MessageTemplate } from '../entities';

const TEMPLATE_BODY_MAX_LENGTH = 1024;
const AUDIT_TABLE_MESSAGE_TEMPLATES = 'message_templates';
const AUDIT_ACTION_TEMPLATE_CREATED = 'whatsapp_template.created';
const AUDIT_ACTION_TEMPLATE_UPDATED = 'whatsapp_template.updated';
const AUDIT_ACTION_TEMPLATE_STATUS_CHANGED = 'whatsapp_template.status_changed';

/**
 * Immutable status transitions (design §9.1 + spec "Template Lifecycle"):
 * draft→submitted|rejected; submitted→approved|rejected; approved→rejected;
 * rejected→draft|submitted. `paused` has no manual transitions — it is only
 * reachable through provider status mirroring (later slice), never via update.
 */
const ALLOWED_STATUS_TRANSITIONS: Record<
  TemplateStatus,
  readonly TemplateStatus[]
> = {
  [TemplateStatus.DRAFT]: [TemplateStatus.SUBMITTED, TemplateStatus.REJECTED],
  [TemplateStatus.SUBMITTED]: [
    TemplateStatus.APPROVED,
    TemplateStatus.REJECTED,
  ],
  [TemplateStatus.APPROVED]: [TemplateStatus.REJECTED],
  [TemplateStatus.REJECTED]: [TemplateStatus.DRAFT, TemplateStatus.SUBMITTED],
  [TemplateStatus.PAUSED]: [],
};

interface PgErrorCrate {
  code?: string;
  driverError?: { code?: string };
}

function isUniqueViolation(error: unknown): boolean {
  const crate = error as PgErrorCrate;
  return crate?.driverError?.code === '23505' || crate?.code === '23505';
}

/**
 * Template CRUD (task 2.2 scope, design §9.1). Create always persists a
 * `draft` row (+ audit `whatsapp_template.created`); submission through the
 * provider and status mirroring land in a later slice. Audit payloads carry
 * only operational fields — never bodies or sample variables (AD9).
 */
@Injectable()
export class TemplatesService {
  constructor(
    @InjectRepository(MessageTemplate)
    private readonly templateRepository: Repository<MessageTemplate>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
  ) {}

  async create(
    createTemplateDto: CreateTemplateDto,
    userId: string | null = null,
  ): Promise<MessageTemplate> {
    const bodyTemplate = this.stripBodyToLimit(createTemplateDto.body);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const template = manager.create(MessageTemplate, {
          name: createTemplateDto.name,
          category: createTemplateDto.category,
          language: createTemplateDto.language,
          bodyTemplate,
          sampleVariables: createTemplateDto.sampleVariables ?? {},
          status: TemplateStatus.DRAFT,
          isActive: true,
          createdByUserId: userId,
        });
        const saved = await manager.save(template);
        await this.logCreatedAudit(manager, saved, userId);
        return saved;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Template name+language already exists');
      }
      handleDatabaseError(error);
    }
  }

  async findAll(
    filters: { status?: TemplateStatus; category?: TemplateCategory } = {},
  ): Promise<MessageTemplate[]> {
    return this.templateRepository.find({
      where: {
        ...(filters.status !== undefined ? { status: filters.status } : {}),
        ...(filters.category !== undefined
          ? { category: filters.category }
          : {}),
      },
    });
  }

  async findOne(id: string): Promise<MessageTemplate> {
    const template = await this.templateRepository.findOne({ where: { id } });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  /**
   * PATCH semantics (design §9.1): only provided fields are applied; an empty
   * payload is a no-op. `status` changes follow the immutable transition map
   * (409 on any other edge). The row is re-audited as `updated` and, on a
   * status change, additionally as `status_changed`.
   */
  async update(
    id: string,
    updateTemplateDto: UpdateTemplateDto,
    userId: string | null = null,
  ): Promise<MessageTemplate> {
    const existing = await this.templateRepository.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Template not found');

    const nextStatus = updateTemplateDto.status;
    if (nextStatus !== undefined && nextStatus !== existing.status) {
      this.assertAllowedTransition(existing.status, nextStatus);
    }

    const changes: Partial<MessageTemplate> = {};
    if (updateTemplateDto.name !== undefined) {
      changes.name = updateTemplateDto.name;
    }
    if (updateTemplateDto.category !== undefined) {
      changes.category = updateTemplateDto.category;
    }
    if (updateTemplateDto.language !== undefined) {
      changes.language = updateTemplateDto.language;
    }
    if (updateTemplateDto.body !== undefined) {
      changes.bodyTemplate = this.stripBodyToLimit(updateTemplateDto.body);
    }
    if (updateTemplateDto.sampleVariables !== undefined) {
      changes.sampleVariables = updateTemplateDto.sampleVariables;
    }
    const statusChanged =
      nextStatus !== undefined && nextStatus !== existing.status;
    if (statusChanged) {
      changes.status = nextStatus;
    }
    if (Object.keys(changes).length === 0) {
      return existing;
    }

    try {
      return await this.dataSource.transaction(async (manager) => {
        const previousData = {
          name: existing.name,
          category: existing.category,
          language: existing.language,
          status: existing.status,
        };
        Object.assign(existing, changes);
        const saved = await manager.save(existing);
        const newData = {
          name: saved.name,
          category: saved.category,
          language: saved.language,
          status: saved.status,
        };
        await this.auditService.log(manager, {
          userId,
          action: AUDIT_ACTION_TEMPLATE_UPDATED,
          tableName: AUDIT_TABLE_MESSAGE_TEMPLATES,
          recordId: saved.id,
          previousData,
          newData,
        });
        if (statusChanged) {
          await this.auditService.log(manager, {
            userId,
            action: AUDIT_ACTION_TEMPLATE_STATUS_CHANGED,
            tableName: AUDIT_TABLE_MESSAGE_TEMPLATES,
            recordId: saved.id,
            previousData: { status: previousData.status },
            newData: { status: saved.status },
          });
        }
        return saved;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('Template name+language already exists');
      }
      handleDatabaseError(error);
    }
  }

  async remove(id: string): Promise<void> {
    const result = await this.templateRepository.delete({ id });
    if (result.affected === 0) {
      throw new NotFoundException('Template not found');
    }
  }

  /**
   * Deactivation (design §9.1): sets `is_active=false` — blocks new dispatches
   * (dispatch gate), never deletes the row. Idempotent: an already-inactive
   * template is returned unchanged without a new audit. The audit carries only
   * the operational isActive field (AD9).
   */
  async deactivate(
    id: string,
    userId: string | null = null,
  ): Promise<MessageTemplate> {
    const existing = await this.templateRepository.findOne({ where: { id } });
    if (!existing) throw new NotFoundException('Template not found');
    if (!existing.isActive) return existing;

    return this.dataSource.transaction(async (manager) => {
      const previousData = { isActive: existing.isActive };
      existing.isActive = false;
      const saved = await manager.save(existing);
      await this.auditService.log(manager, {
        userId,
        action: AUDIT_ACTION_TEMPLATE_UPDATED,
        tableName: AUDIT_TABLE_MESSAGE_TEMPLATES,
        recordId: saved.id,
        previousData,
        newData: { isActive: saved.isActive },
      });
      return saved;
    });
  }

  private assertAllowedTransition(
    from: TemplateStatus,
    to: TemplateStatus,
  ): void {
    const allowed = ALLOWED_STATUS_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new ConflictException(
        `Template status cannot change from ${from} to ${to}`,
      );
    }
  }

  private stripBodyToLimit(body: string): string {
    return body.length > TEMPLATE_BODY_MAX_LENGTH
      ? body.slice(0, TEMPLATE_BODY_MAX_LENGTH)
      : body;
  }

  private async logCreatedAudit(
    manager: EntityManager,
    template: MessageTemplate,
    userId: string | null,
  ): Promise<void> {
    await this.auditService.log(manager, {
      userId,
      action: AUDIT_ACTION_TEMPLATE_CREATED,
      tableName: AUDIT_TABLE_MESSAGE_TEMPLATES,
      recordId: template.id,
      newData: {
        name: template.name,
        category: template.category,
        language: template.language,
        status: template.status,
      },
    });
  }
}
