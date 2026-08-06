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
 * Maps Meta template events (design §5.1 `provider_status` raw mirror:
 * IN_APPROVAL/APPROVED/REJECTED/PAUSED/…) to template statuses. Case
 * insensitive; events with no mapping (IN_APPEAL, PENDING_DELETION,
 * DISABLED, …) return null so the webhook can answer 200 no-op — the mirror
 * NEVER throws on an unknown provider status (task 4.3 re-scope, webhook
 * §9.3 item 3). Pure — no side effects.
 */
export function mapProviderStatusToTemplateStatus(
  providerStatus: string,
): TemplateStatus | null {
  const normalized = providerStatus.toUpperCase();
  switch (normalized) {
    case 'IN_APPROVAL':
      return TemplateStatus.SUBMITTED;
    case 'APPROVED':
      return TemplateStatus.APPROVED;
    case 'REJECTED':
      return TemplateStatus.REJECTED;
    case 'PAUSED':
      return TemplateStatus.PAUSED;
    default:
      return null;
  }
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

  /**
   * Provider status mirroring for the public webhook (design §9.1 item 3,
   * task 4.3 re-scope). Minimal webhook-required contract — NOT the full 2.4
   * lifecycle scope, which stays pending for its template-lifecycle spec.
   *
   * Contract: finds the template by `provider_template_id`; maps the provider
   * status via {@link mapProviderStatusToTemplateStatus}; applies the
   * transition ONLY when it is allowed by the immutable transition map
   * (submitted→approved/rejected, draft→submitted, …). Idempotent: a repeat of
   * the current status is a no-op with no audit. Unknown provider statuses,
   * unknown template ids, and non-allowed (regressive) transitions are all
   * silent no-ops — this method NEVER throws, so the webhook always answers
   * 200 fast. The raw provider status is mirrored into `provider_status` on an
   * effective change; the audit carries only operational fields (AD9) with
   * userId null (system event).
   *
   * @returns the updated template, or null when nothing was applied.
   */
  async mirrorProviderStatus(
    providerTemplateId: string,
    providerStatus: string,
  ): Promise<MessageTemplate | null> {
    const existing = await this.templateRepository.findOne({
      where: { providerTemplateId },
    });
    if (!existing) return null;

    const mapped = mapProviderStatusToTemplateStatus(providerStatus);
    if (mapped === null || mapped === existing.status) {
      return existing;
    }
    if (!ALLOWED_STATUS_TRANSITIONS[existing.status].includes(mapped)) {
      // Regression guard: an out-of-order provider event (e.g. APPROVED
      // arriving for a draft) must not move the template backwards.
      return existing;
    }

    return this.dataSource.transaction(async (manager) => {
      const previousStatus = existing.status;
      existing.status = mapped;
      existing.providerStatus = providerStatus;
      const saved = await manager.save(existing);
      await this.auditService.log(manager, {
        userId: null,
        action: AUDIT_ACTION_TEMPLATE_STATUS_CHANGED,
        tableName: AUDIT_TABLE_MESSAGE_TEMPLATES,
        recordId: saved.id,
        previousData: { status: previousStatus },
        newData: { status: saved.status, providerStatus: saved.providerStatus },
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
