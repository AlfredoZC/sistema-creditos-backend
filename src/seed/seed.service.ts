import { User } from './../auth/entities/user.entity';
import { Profile } from './../profile/entities/profile.entity';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  SeedAuditLog,
  SeedBotConversation,
  SeedBotMessage,
  SeedDoctor,
  SeedInstallment,
  SeedMessageTemplate,
  SeedPatient,
  SeedPayment,
  SeedPaymentPlan,
  SeedProfile,
  SeedSurgery,
  SeedSurgeryCatalog,
  SeedSurgeryDoctor,
  SeedWhatsappDispatch,
  initialData,
} from './data/seed-data';

type PaymentMethodRow = { name: string; id: string };

/**
 * Whole-system demo seed (design section 9 and the financing engine rules).
 *
 * The wipe truncates every business table (never payment_methods, which the
 * migrations seed) and every row inserted below carries an explicit uuid so
 * repeated runs are byte-identical. FK-safe insert order is user-, profile-,
 * then business-table order; money values are decimal strings end to end.
 */
@Injectable()
export class SeedService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  async runSeed(): Promise<string> {
    await this.deleteTables();

    const profileIds = await this.insertProfiles();
    await this.insertUsers(profileIds);
    await this.insertPatients();
    await this.insertDoctors();
    await this.insertSurgeryCatalog();
    await this.insertSurgeries();
    await this.insertSurgeryDoctors();
    await this.insertPaymentPlans();
    await this.insertInstallments();
    const paymentMethods = await this.loadPaymentMethods();
    await this.insertPayments(paymentMethods);
    await this.insertAuditLogs();
    await this.insertMessageTemplates();
    await this.insertWhatsappDispatches();
    await this.insertBotConversations();
    await this.insertBotMessages();

    return 'SEED EXECUTED';
  }

  private async deleteTables(): Promise<void> {
    await this.dataSource.query(
      `TRUNCATE TABLE "audit_logs", "payments", "bot_messages",
        "bot_conversations", "whatsapp_dispatches", "phone_normalization_backup",
        "message_templates", "installments", "payment_plans", "surgery_doctors",
        "surgeries", "surgery_catalog", "patients", "doctors", "users", "profiles"
        RESTART IDENTITY CASCADE`,
    );
  }

  /** Inserts the static profile rows and returns their serial ids in order. */
  private async insertProfiles(): Promise<number[]> {
    const profiles = initialData.profiles;
    const profileIds: number[] = [];

    for (const profile of profiles) {
      const rows: Array<{ id: number }> = await this.dataSource.query(
        `INSERT INTO profiles (gender, photo, "photoPublicId")
         VALUES ($1, $2, $3) RETURNING id`,
        [profile.gender, profile.photo, profile.photoPublicId],
      );
      profileIds.push(rows[0].id);
    }

    return profileIds;
  }

  private async insertUsers(profileIds: number[]): Promise<void> {
    const profileIdByUserIndex = new Map<number, number>();
    initialData.profiles.forEach((profile, index) => {
      profileIdByUserIndex.set(profile.userIndex, profileIds[index]);
    });

    const users = initialData.users.map((user, index) =>
      this.userRepository.create({
        id: user.id,
        email: user.email,
        password: user.password,
        name: user.name,
        role: user.role,
        isActive: true,
        profile: profileIdByUserIndex.has(index)
          ? ({ id: profileIdByUserIndex.get(index) } as Profile)
          : undefined,
      }),
    );

    await this.userRepository.save(users);
  }

  private async insertPatients(): Promise<void> {
    await this.insertRows(
      'patients',
      [
        'id',
        'user_id',
        'identity_document',
        'first_name',
        'paternal_last_name',
        'maternal_last_name',
        'birth_date',
        'address',
        'phone',
      ],
      initialData.patients.map(
        (p: SeedPatient): Record<string, unknown> => ({
          id: p.id,
          user_id: p.userId,
          identity_document: p.identityDocument,
          first_name: p.firstName,
          paternal_last_name: p.paternalLastName,
          maternal_last_name: p.maternalLastName,
          birth_date: p.birthDate,
          address: p.address,
          phone: p.phone,
        }),
      ),
    );
  }

  private async insertDoctors(): Promise<void> {
    await this.insertRows(
      'doctors',
      [
        'id',
        'user_id',
        'specialty',
        'professional_license',
        'first_name',
        'paternal_last_name',
        'maternal_last_name',
        'phone',
      ],
      initialData.doctors.map(
        (d: SeedDoctor): Record<string, unknown> => ({
          id: d.id,
          user_id: d.userId,
          specialty: d.specialty,
          professional_license: d.professionalLicense,
          first_name: d.firstName,
          paternal_last_name: d.paternalLastName,
          maternal_last_name: d.maternalLastName,
          phone: d.phone,
        }),
      ),
    );
  }

  private async insertSurgeryCatalog(): Promise<void> {
    await this.insertRows(
      'surgery_catalog',
      ['id', 'name', 'description', 'base_cost'],
      initialData.surgeryCatalog.map(
        (c: SeedSurgeryCatalog): Record<string, unknown> => ({
          id: c.id,
          name: c.name,
          description: c.description,
          base_cost: c.baseCost,
        }),
      ),
    );
  }

  private async insertSurgeries(): Promise<void> {
    await this.insertRows(
      'surgeries',
      ['id', 'patient_id', 'surgery_catalog_id', 'scheduled_date', 'total_cost', 'status', 'notes'],
      initialData.surgeries.map(
        (s: SeedSurgery): Record<string, unknown> => ({
          id: s.id,
          patient_id: s.patientId,
          surgery_catalog_id: s.surgeryCatalogId,
          scheduled_date: s.scheduledDate,
          total_cost: s.totalCost,
          status: s.status,
          notes: s.notes,
        }),
      ),
    );
  }

  private async insertSurgeryDoctors(): Promise<void> {
    await this.insertRows(
      'surgery_doctors',
      ['id', 'surgery_id', 'doctor_id', 'role'],
      initialData.surgeryDoctors.map(
        (sd: SeedSurgeryDoctor): Record<string, unknown> => ({
          id: sd.id,
          surgery_id: sd.surgeryId,
          doctor_id: sd.doctorId,
          role: sd.role,
        }),
      ),
    );
  }

  private async insertPaymentPlans(): Promise<void> {
    await this.insertRows(
      'payment_plans',
      [
        'id',
        'surgery_id',
        'type',
        'down_payment',
        'financed_amount',
        'monthly_interest_rate',
        'installment_count',
        'start_date',
        'outstanding_balance',
        'status',
      ],
      initialData.paymentPlans.map(
        (p: SeedPaymentPlan): Record<string, unknown> => ({
          id: p.id,
          surgery_id: p.surgeryId,
          type: p.type,
          down_payment: p.downPayment,
          financed_amount: this.financedAmount(p),
          monthly_interest_rate: p.monthlyInterestRate,
          installment_count: p.installmentCount,
          start_date: p.startDate,
          outstanding_balance: p.outstandingBalance ?? '0.00',
          status: p.status,
        }),
      ),
    );
  }

  /** financed_amount = surgery.total_cost - down_payment, always a decimal string. */
  private financedAmount(plan: SeedPaymentPlan): string {
    const surgery = initialData.surgeries.find((s) => s.id === plan.surgeryId);
    if (!surgery) {
      throw new Error(`Seed plan references unknown surgery ${plan.surgeryId}`);
    }
    const downPayment = Number.parseFloat(plan.downPayment);
    const totalCost = Number.parseFloat(surgery.totalCost);
    return (totalCost - downPayment).toFixed(2);
  }

  private async insertInstallments(): Promise<void> {
    await this.insertRows(
      'installments',
      [
        'id',
        'payment_plan_id',
        'installment_number',
        'principal_amount',
        'interest_amount',
        'total_amount',
        'paid_amount',
        'due_date',
        'status',
      ],
      initialData.installments.map(
        (i: SeedInstallment): Record<string, unknown> => ({
          id: i.id,
          payment_plan_id: i.paymentPlanId,
          installment_number: i.installmentNumber,
          principal_amount: i.principalAmount,
          interest_amount: i.interestAmount,
          total_amount: i.totalAmount,
          paid_amount: i.paidAmount,
          due_date: i.dueDate,
          status: i.status,
        }),
      ),
    );
  }

  private async loadPaymentMethods(): Promise<Map<string, string>> {
    const rows: PaymentMethodRow[] = await this.dataSource.query(
      'SELECT id, name FROM payment_methods ORDER BY name',
    );
    return new Map(rows.map((row) => [row.name, row.id]));
  }

  private async insertPayments(paymentMethods: Map<string, string>): Promise<void> {
    const rows = initialData.payments.map((p: SeedPayment): Record<string, unknown> => {
      const methodId = paymentMethods.get(p.paymentMethod);
      if (!methodId) {
        throw new Error(
          `Seed payment references unknown payment method '${p.paymentMethod}'`,
        );
      }
      return {
        id: p.id,
        payment_plan_id: p.paymentPlanId,
        installment_id: p.installmentId,
        patient_user_id: p.patientUserId,
        recorded_by_user_id: p.recordedByUserId,
        payment_method_id: methodId,
        amount: p.amount,
        type: p.type,
        amortization_mode: p.amortizationMode,
        paid_at: p.paidAt,
        status: p.status,
      };
    });

    await this.insertRows(
      'payments',
      [
        'id',
        'payment_plan_id',
        'installment_id',
        'patient_user_id',
        'recorded_by_user_id',
        'payment_method_id',
        'amount',
        'type',
        'amortization_mode',
        'paid_at',
        'status',
      ],
      rows,
    );
  }

  private async insertAuditLogs(): Promise<void> {
    await this.insertRows(
      'audit_logs',
      ['id', 'user_id', 'action', 'table_name', 'record_id', 'previous_data', 'new_data', 'created_at'],
      initialData.auditLogs.map(
        (a: SeedAuditLog): Record<string, unknown> => ({
          id: a.id,
          user_id: a.userId,
          action: a.action,
          table_name: a.tableName,
          record_id: a.recordId,
          previous_data: a.previousData
            ? JSON.stringify(a.previousData)
            : null,
          new_data: a.newData ? JSON.stringify(a.newData) : null,
          created_at: a.createdAt,
        }),
      ),
    );
  }

  private async insertMessageTemplates(): Promise<void> {
    await this.insertRows(
      'message_templates',
      [
        'id',
        'name',
        'category',
        'language',
        'body_template',
        'sample_variables',
        'status',
        'provider_template_id',
        'provider_status',
        'is_active',
        'created_by_user_id',
      ],
      initialData.messageTemplates.map(
        (t: SeedMessageTemplate): Record<string, unknown> => ({
          id: t.id,
          name: t.name,
          category: t.category,
          language: t.language,
          body_template: t.bodyTemplate,
          sample_variables: JSON.stringify(t.sampleVariables),
          status: t.status,
          provider_template_id: t.providerTemplateId,
          provider_status: t.providerStatus,
          is_active: t.isActive,
          created_by_user_id: t.createdByUserId,
        }),
      ),
    );
  }

  private async insertWhatsappDispatches(): Promise<void> {
    await this.insertRows(
      'whatsapp_dispatches',
      [
        'id',
        'patient_id',
        'template_id',
        'status',
        'send_attempts',
        'provider_message_id',
        'provider_error',
        'payload',
        'phone',
        'dedupe_key',
        'created_by_user_id',
        'sent_at',
      ],
      initialData.whatsappDispatches.map(
        (d: SeedWhatsappDispatch): Record<string, unknown> => ({
          id: d.id,
          patient_id: d.patientId,
          template_id: d.templateId,
          status: d.status,
          send_attempts: d.sendAttempts,
          provider_message_id: d.providerMessageId,
          provider_error: d.providerError,
          payload: JSON.stringify(d.payload),
          phone: d.phone,
          dedupe_key: d.dedupeKey,
          created_by_user_id: d.createdByUserId,
          sent_at: d.sentAt,
        }),
      ),
    );
  }

  private async insertBotConversations(): Promise<void> {
    await this.insertRows(
      'bot_conversations',
      [
        'id',
        'wa_id',
        'patient_id',
        'state',
        'failed_attempts',
        'lockout_until',
        'last_activity_at',
        'started_at',
        'ended_at',
      ],
      initialData.botConversations.map(
        (c: SeedBotConversation): Record<string, unknown> => ({
          id: c.id,
          wa_id: c.waId,
          patient_id: c.patientId,
          state: c.state,
          failed_attempts: c.failedAttempts,
          lockout_until: c.lockoutUntil,
          last_activity_at: c.lastActivityAt,
          started_at: c.startedAt,
          ended_at: c.endedAt,
        }),
      ),
    );
  }

  private async insertBotMessages(): Promise<void> {
    await this.insertRows(
      'bot_messages',
      [
        'id',
        'conversation_id',
        'direction',
        'body',
        'provider_message_id',
        'type',
        'template_id',
        'intent',
        'metadata',
        'created_at',
      ],
      initialData.botMessages.map(
        (m: SeedBotMessage): Record<string, unknown> => ({
          id: m.id,
          conversation_id: m.conversationId,
          direction: m.direction,
          body: m.body,
          provider_message_id: m.providerMessageId,
          type: m.type,
          template_id: m.templateId,
          intent: m.intent,
          metadata: JSON.stringify(m.metadata),
          created_at: m.createdAt,
        }),
      ),
    );
  }

  /**
   * Bulk parameterized insert of pre-shaped rows. All columns are quoted and
   * every value is positional, so money stays decimal strings and jsonb values
   * arrive pre-serialized.
   */
  private async insertRows(
    table: string,
    columns: readonly string[],
    rows: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const columnList = columns.map((column) => `"${column}"`).join(', ');
    const valueGroups = rows
      .map(
        (_, index) =>
          `(${columns
            .map((__, columnIndex) => `$${index * columns.length + columnIndex + 1}`)
            .join(', ')})`,
      )
      .join(', ');
    const params = rows.flatMap((row) => columns.map((column) => row[column]));

    await this.dataSource.query(
      `INSERT INTO "${table}" (${columnList}) VALUES ${valueGroups}`,
      params,
    );
  }
}