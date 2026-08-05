import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { createHash } from 'crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  DispatchStatus,
  TemplateStatus,
} from '../common/enums';
import { handleDatabaseError } from '../common/errors';
import { normalizePhone } from './phone-normalizer';
import { truncateErrorMessage } from './provider/provider-errors';
import {
  SendTemplateMessageInput,
  WhatsAppProvider,
} from './provider/whatsapp-provider.interface';
import { MessageTemplate, WhatsAppDispatch } from './entities';
import { WHATSAPP_PROVIDER } from './provider/whatsapp-provider.token';

const MAX_SEND_ATTEMPTS = 3;
const AUDIT_TABLE_DISPATCHES = 'whatsapp_dispatches';
const AUDIT_ACTION_DISPATCH_CREATED = 'whatsapp_dispatch.created';
const AUDIT_ACTION_DISPATCH_STATUS_CHANGED = 'whatsapp_dispatch.status_changed';

/**
 * Dedupe-key separator (design D1): `sha256(patient_id ‖ template_id ‖
 * created_by_user_id ‖ canonicalJson(variables))`. The separator keeps the
 * four concatenated parts unambiguous.
 */
const DEDUPE_KEY_SEPARATOR = '‖';

const PLACEHOLDER_PATTERN = /\{\{(\d+)\}\}/g;

interface PgErrorCrate {
  code?: string;
  driverError?: { code?: string };
}

function isUniqueViolation(error: unknown): boolean {
  const crate = error as PgErrorCrate;
  return crate?.driverError?.code === '23505' || crate?.code === '23505';
}

/**
 * Extracts the placeholder numbers of a template body (`{{1}}..{{N}}`) in
 * declaration order. Pure — no side effects, no dependencies.
 */
export function extractPlaceholderNumbers(bodyTemplate: string): number[] {
  const numbers: number[] = [];
  for (const match of bodyTemplate.matchAll(PLACEHOLDER_PATTERN)) {
    numbers.push(Number(match[1]));
  }
  return numbers;
}

/**
 * Deterministic JSON serialization: keys sorted so `{ '1': 'A', '2': 'B' }`
 * and `{ '2': 'B', '1': 'A' }` hash to the same dedupe key (design D1 —
 * "canonicalizes the JSON so key order cannot split the dedupe"). Pure.
 */
export function canonicalJson(value: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

/**
 * Deterministic duplicate guard (design D1). The key excludes the dispatch
 * id itself so two racing identical requests compute the same key and the
 * UNIQUE column serializes them (23505 → 409). `created_by_user_id` is part
 * of the key: two different office actors may legitimately re-send the same
 * reminder to the same patient later.
 */
export function computeDispatchDedupeKey(
  patientId: string,
  templateId: string,
  createdByUserId: string | null,
  variables: Record<string, string>,
): string {
  const raw = [
    patientId,
    templateId,
    createdByUserId ?? '',
    canonicalJson(variables),
  ].join(DEDUPE_KEY_SEPARATOR);
  return createHash('sha256').update(raw).digest('hex');
}

export interface CreateDispatchInput {
  patientId: string;
  templateId: string;
  variables: Record<string, string>;
}

/**
 * Outbound dispatch flow (design §9.2, spec "Outbound Dispatch Trigger").
 *
 * create: template dispatchable gate (409) + variables 1:1 vs placeholders
 * (400) -> TX { insert `queued` with send_attempts=1 (finding 5), phone
 * snapshot = normalizePhone(patient.phone), payload = resolved variables
 * only, dedupe_key, audit whatsapp_dispatch.created } -> COMMIT ->
 * provider.sendTemplate (AD5) -> 'sent' + wamid + sent_at + audit
 * status_changed | 'failed' + truncated provider_error + audit.
 *
 * retry: manual only; accepted ONLY from queued|failed (else 409); gate
 * send_attempts < 3 (else 409 — office creates a new dispatch, D2); TX {
 * status->'queued', send_attempts += 1, audit status_changed } -> COMMIT ->
 * send.
 *
 * Duplicate identical requests hit the dedupe_key UNIQUE (23505) and are
 * mapped to 409 Conflict via handleDatabaseError (D1). Audit payloads carry
 * only operational fields — never the phone, the resolved variables, or
 * provider_error (AD9).
 */
@Injectable()
export class DispatchesService {
  constructor(
    @InjectRepository(WhatsAppDispatch)
    private readonly dispatchRepository: Repository<WhatsAppDispatch>,
    @InjectRepository(MessageTemplate)
    private readonly templateRepository: Repository<MessageTemplate>,
    private readonly dataSource: DataSource,
    private readonly auditService: AuditService,
    @Inject(WHATSAPP_PROVIDER)
    private readonly provider: WhatsAppProvider,
  ) {}

  async create(
    input: CreateDispatchInput,
    userId: string | null = null,
  ): Promise<WhatsAppDispatch> {
    const template = await this.requireDispatchableTemplate(input.templateId);
    const placeholderNumbers = extractPlaceholderNumbers(
      template.bodyTemplate,
    );
    assertVariablesMatchPlaceholders(placeholderNumbers, input.variables);
    const phoneSnapshot = await this.patientPhoneSnapshot(input.patientId);

    const dedupeKey = computeDispatchDedupeKey(
      input.patientId,
      input.templateId,
      userId,
      input.variables,
    );

    let dispatch: WhatsAppDispatch;
    try {
      dispatch = await this.dataSource.transaction(async (manager) => {
        const created = manager.create(WhatsAppDispatch, {
          patientId: input.patientId,
          templateId: input.templateId,
          status: DispatchStatus.QUEUED,
          // Finding 5: the first send attempt counts when the attempt starts —
          // the initial insert IS attempt 1, so it routes queued with 1.
          sendAttempts: 1,
          providerMessageId: null,
          providerError: null,
          payload: input.variables,
          phone: phoneSnapshot,
          dedupeKey,
          createdByUserId: userId,
        });
        const saved = await manager.save(created);
        await this.logCreatedAudit(manager, saved, userId);
        return saved;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('An identical dispatch already exists');
      }
      handleDatabaseError(error);
    }

    return this.send(dispatch, template, userId);
  }

  /**
   * Manual retry (design §9.2). Re-routes a queued|failed dispatch through
   * 'queued' with send_attempts += 1 BEFORE the provider call (crash-consistent
   * with the max-3 gate, D2/finding 5), then sends. Terminal statuses and the
   * attempt limit are rejected with 409 before any row is touched.
   */
  async retry(
    id: string,
    userId: string | null = null,
  ): Promise<WhatsAppDispatch> {
    const dispatch = await this.dispatchRepository.findOne({ where: { id } });
    if (!dispatch) throw new NotFoundException('Dispatch not found');

    const retryable =
      dispatch.status === DispatchStatus.QUEUED ||
      dispatch.status === DispatchStatus.FAILED;
    if (!retryable) {
      throw new ConflictException(
        'Only queued or failed dispatches can be retried',
      );
    }
    if (dispatch.sendAttempts >= MAX_SEND_ATTEMPTS) {
      throw new ConflictException(
        `Maximum send attempts (${MAX_SEND_ATTEMPTS}) reached; create a new dispatch`,
      );
    }
    const template = await this.templateRepository.findOne({
      where: { id: dispatch.templateId },
    });
    if (!template) throw new NotFoundException('Template not found');

    const previousStatus = dispatch.status;
    await this.dataSource.transaction(async (manager) => {
      dispatch.status = DispatchStatus.QUEUED;
      dispatch.sendAttempts += 1;
      dispatch.providerError = null;
      await manager.save(dispatch);
      await this.logStatusChangedAudit(
        manager,
        dispatch.id,
        userId,
        { status: previousStatus },
        { status: dispatch.status, sendAttempts: dispatch.sendAttempts },
      );
    });

    return this.send(dispatch, template, userId);
  }

  /**
   * The provider call (AD5): always AFTER the business transaction commits.
   * Success routes the row to 'sent' with the wamid and sent_at; any provider
   * failure routes it to 'failed' with a truncated provider_error — never
   * mirrored to the audit (design §5.2 note, AD9).
   */
  private async send(
    dispatch: WhatsAppDispatch,
    template: MessageTemplate,
    userId: string | null,
  ): Promise<WhatsAppDispatch> {
    const sendInput: SendTemplateMessageInput = {
      to: dispatch.phone,
      templateName: template.name,
      language: template.language,
      variables: Object.entries(dispatch.payload).map(([name, value]) => ({
        name,
        value,
      })),
    };

    try {
      const result = await this.provider.sendTemplate(sendInput);
      return await this.dataSource.transaction(async (manager) => {
        const previousStatus = dispatch.status;
        dispatch.status = DispatchStatus.SENT;
        dispatch.providerMessageId = result.providerMessageId;
        dispatch.sentAt = new Date();
        const saved = await manager.save(dispatch);
        await this.logStatusChangedAudit(
          manager,
          saved.id,
          userId,
          { status: previousStatus },
          {
            status: saved.status,
            providerMessageId: saved.providerMessageId,
          },
        );
        return saved;
      });
    } catch (error) {
      return await this.dataSource.transaction(async (manager) => {
        const previousStatus = dispatch.status;
        dispatch.status = DispatchStatus.FAILED;
        dispatch.providerError = truncateErrorMessage(
          error instanceof Error
            ? error.message
            : 'Unknown provider send failure',
        );
        const saved = await manager.save(dispatch);
        await this.logStatusChangedAudit(
          manager,
          saved.id,
          userId,
          { status: previousStatus },
          { status: saved.status },
        );
        return saved;
      });
    }
  }

  /**
   * Dispatch gate (design §9.1, service-shared): dispatchable ⇔
   * status='approved' AND is_active=true; everything else is 409 with no row
   * or provider call (spec "Rejected, paused, or deactivated blocked").
   */
  private async requireDispatchableTemplate(
    templateId: string,
  ): Promise<MessageTemplate> {
    const template = await this.templateRepository.findOne({
      where: { id: templateId },
    });
    if (!template) throw new NotFoundException('Template not found');
    if (
      template.status !== TemplateStatus.APPROVED ||
      !template.isActive
    ) {
      throw new ConflictException(
        'Template is not dispatchable (must be approved and active)',
      );
    }
    return template;
  }

  private async patientPhoneSnapshot(patientId: string): Promise<string> {
    const rows: { phone: string }[] = await this.dataSource.query(
      'SELECT phone FROM patients WHERE id = $1',
      [patientId],
    );
    if (rows.length === 0) throw new NotFoundException('Patient not found');
    // Canonical snapshot at dispatch time (spec "Non-PII payload and phone
    // snapshot"): the patient's stored phone, normalized once.
    return normalizePhone(rows[0].phone);
  }

  private async logCreatedAudit(
    manager: EntityManager,
    dispatch: WhatsAppDispatch,
    userId: string | null,
  ): Promise<void> {
    await this.auditService.log(manager, {
      userId,
      action: AUDIT_ACTION_DISPATCH_CREATED,
      tableName: AUDIT_TABLE_DISPATCHES,
      recordId: dispatch.id,
      newData: {
        patientId: dispatch.patientId,
        templateId: dispatch.templateId,
        status: dispatch.status,
        sendAttempts: dispatch.sendAttempts,
      },
    });
  }

  private async logStatusChangedAudit(
    manager: EntityManager,
    dispatchId: string,
    userId: string | null,
    previousData: Record<string, unknown>,
    newData: Record<string, unknown>,
  ): Promise<void> {
    await this.auditService.log(manager, {
      userId,
      action: AUDIT_ACTION_DISPATCH_STATUS_CHANGED,
      tableName: AUDIT_TABLE_DISPATCHES,
      recordId: dispatchId,
      previousData,
      newData,
    });
  }
}

/**
 * Dispatch variable validation (spec "Placeholder mismatch rejected"): the
 * supplied variables MUST map 1:1 to the template's contiguous `{{1}}..{{N}}`
 * placeholders — missing, extra, or empty substitutions are rejected with
 * 400 before any row, audit, or provider call.
 */
export function assertVariablesMatchPlaceholders(
  placeholderNumbers: number[],
  variables: Record<string, string>,
): void {
  const placeholderSet = new Set(placeholderNumbers);

  // Contiguity: a body declaring {{1}} and {{3}} (no {{2}}) is malformed.
  const maxPlaceholder = Math.max(...placeholderNumbers);
  for (let i = 1; i <= maxPlaceholder; i += 1) {
    if (!placeholderSet.has(i)) {
      throw new BadRequestException(
        `Template body declares non-contiguous placeholders; missing {{${i}}}`,
      );
    }
  }

  const variableKeys = Object.keys(variables);
  const variableNumbers = new Set(variableKeys.map(Number));

  if (placeholderSet.size !== variableNumbers.size) {
    throw new BadRequestException(
      'Variables must match the template placeholders 1:1',
    );
  }
  for (const placeholder of placeholderSet) {
    if (!variableNumbers.has(placeholder)) {
      throw new BadRequestException(
        `Missing variable for placeholder {{${placeholder}}}`,
      );
    }
  }
  for (const key of variableKeys) {
    if (!placeholderSet.has(Number(key))) {
      throw new BadRequestException(
        `Variable "${key}" has no matching placeholder`,
      );
    }
    if (variables[key] === '') {
      throw new BadRequestException(
        `Variable for placeholder {{${key}}} must not be empty`,
      );
    }
  }
}
