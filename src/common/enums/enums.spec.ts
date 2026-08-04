import {
  AmortizationMode,
  BotConversationState,
  BotDirection,
  DispatchStatus,
  InstallmentStatus,
  PaymentPlanStatus,
  PaymentPlanType,
  PaymentStatus,
  PaymentType,
  SurgeryDoctorRole,
  SurgeryStatus,
  TemplateCategory,
  TemplateStatus,
  UserRole,
} from './index';

describe('shared domain enums (design section 4 — 1:1 with PG enum types)', () => {
  it('UserRole maps user_role values in declaration order', () => {
    expect(Object.values(UserRole)).toEqual([
      'patient',
      'doctor',
      'office',
      'admin',
    ]);
  });

  it('SurgeryStatus maps surgery_status values in declaration order', () => {
    expect(Object.values(SurgeryStatus)).toEqual([
      'scheduled',
      'performed',
      'cancelled',
    ]);
  });

  it('SurgeryDoctorRole maps surgery_doctor_role values in declaration order', () => {
    expect(Object.values(SurgeryDoctorRole)).toEqual([
      'principal',
      'assistant',
      'anesthesiologist',
    ]);
  });

  it('PaymentPlanType maps payment_plan_type values in declaration order', () => {
    expect(Object.values(PaymentPlanType)).toEqual(['upfront', 'credit']);
  });

  it('PaymentPlanStatus maps payment_plan_status values in declaration order', () => {
    expect(Object.values(PaymentPlanStatus)).toEqual([
      'active',
      'completed',
      'delinquent',
      'cancelled',
    ]);
  });

  it('InstallmentStatus maps installment_status values in declaration order including cancelled', () => {
    expect(Object.values(InstallmentStatus)).toEqual([
      'pending',
      'partial',
      'paid',
      'overdue',
      'cancelled',
    ]);
    expect(InstallmentStatus.CANCELLED).toBe('cancelled');
  });

  it('PaymentType maps payment_type values in declaration order', () => {
    expect(Object.values(PaymentType)).toEqual([
      'down_payment',
      'installment_payment',
      'principal_amortization',
    ]);
  });

  it('PaymentStatus maps payment_status values in declaration order', () => {
    expect(Object.values(PaymentStatus)).toEqual([
      'pending_confirmation',
      'confirmed',
      'rejected',
    ]);
  });

  it('AmortizationMode maps amortization_mode values in declaration order', () => {
    expect(Object.values(AmortizationMode)).toEqual([
      'reduce_installment',
      'reduce_term',
    ]);
  });

  it('DispatchStatus maps dispatch_status values in declaration order', () => {
    expect(Object.values(DispatchStatus)).toEqual([
      'queued',
      'sent',
      'delivered',
      'read',
      'failed',
    ]);
  });

  it('BotDirection maps bot_direction values in declaration order', () => {
    expect(Object.values(BotDirection)).toEqual(['inbound', 'outbound']);
  });

  it('BotConversationState maps bot_conversation_state values in declaration order', () => {
    expect(Object.values(BotConversationState)).toEqual([
      'unidentified',
      'awaiting_document',
      'identified',
    ]);
  });

  it('TemplateCategory maps template_category values in declaration order', () => {
    expect(Object.values(TemplateCategory)).toEqual([
      'utility',
      'marketing',
      'authentication',
    ]);
  });

  it('TemplateStatus maps template_status values in declaration order', () => {
    expect(Object.values(TemplateStatus)).toEqual([
      'draft',
      'submitted',
      'approved',
      'rejected',
      'paused',
    ]);
  });
});
