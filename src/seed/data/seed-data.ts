import * as bcrypt from 'bcrypt';
import Decimal from 'decimal.js';
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
} from '../../common/enums';
import { FinancingEngine } from '../../payment-plans/financing/financing-engine';

const SEED_PASSWORD = 'Abc123';
const financingEngine = new FinancingEngine();

// ---- Row shapes -------------------------------------------------------------

export interface SeedUser {
  id: string;
  email: string;
  name: string;
  password: string;
  role: UserRole;
}

export interface SeedProfile {
  userIndex: number;
  gender: string;
  photo: string;
  photoPublicId: string;
}

export interface SeedPatient {
  id: string;
  userId: string | null;
  identityDocument: string;
  firstName: string;
  paternalLastName: string;
  maternalLastName: string | null;
  birthDate: string;
  address: string;
  phone: string;
}

export interface SeedDoctor {
  id: string;
  userId: string;
  specialty: string;
  professionalLicense: string;
  firstName: string;
  paternalLastName: string;
  maternalLastName: string | null;
  phone: string;
}

export interface SeedSurgeryCatalog {
  id: string;
  name: string;
  description: string;
  baseCost: string;
}

export interface SeedSurgery {
  id: string;
  patientId: string;
  surgeryCatalogId: string;
  scheduledDate: string;
  totalCost: string;
  status: SurgeryStatus;
  notes: string | null;
}

export interface SeedSurgeryDoctor {
  id: string;
  surgeryId: string;
  doctorId: string;
  role: SurgeryDoctorRole;
}

export interface SeedInstallmentOverride {
  number: number;
  status: InstallmentStatus;
  paidAmount?: string;
}

export interface SeedPaymentPlan {
  id: string;
  surgeryId: string;
  type: PaymentPlanType;
  downPayment: string;
  monthlyInterestRate: string;
  installmentCount: number;
  startDate: string;
  status: PaymentPlanStatus;
  installmentOverrides: SeedInstallmentOverride[];
  amortizations: string[];
  /** Filled by the exported initialData map; the raw specs omit it. */
  outstandingBalance?: string;
}

export interface SeedInstallment {
  id: string;
  paymentPlanId: string;
  installmentNumber: number;
  principalAmount: string;
  interestAmount: string;
  totalAmount: string;
  paidAmount: string;
  dueDate: string;
  status: InstallmentStatus;
}

export interface SeedPayment {
  id: string;
  paymentPlanId: string;
  installmentId: string | null;
  patientUserId: string | null;
  recordedByUserId: string;
  paymentMethod: 'cash' | 'bank_transfer' | 'qr' | 'card';
  amount: string;
  type: PaymentType;
  amortizationMode: AmortizationMode | null;
  paidAt: string;
  status: PaymentStatus;
}

export interface SeedAuditLog {
  id: string;
  userId: string | null;
  action: string;
  tableName: string;
  recordId: string;
  previousData: Record<string, unknown> | null;
  newData: Record<string, unknown> | null;
  createdAt: string;
}

export interface SeedMessageTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  language: string;
  bodyTemplate: string;
  sampleVariables: Record<string, string>;
  status: TemplateStatus;
  providerTemplateId: string | null;
  providerStatus: string | null;
  isActive: boolean;
  createdByUserId: string | null;
}

export interface SeedWhatsappDispatch {
  id: string;
  patientId: string;
  templateId: string;
  status: DispatchStatus;
  sendAttempts: number;
  providerMessageId: string | null;
  providerError: string | null;
  payload: Record<string, string>;
  phone: string;
  dedupeKey: string;
  createdByUserId: string | null;
  sentAt: string | null;
}

export interface SeedBotConversation {
  id: string;
  waId: string;
  patientId: string | null;
  state: BotConversationState;
  failedAttempts: number;
  lockoutUntil: string | null;
  lastActivityAt: string;
  startedAt: string;
  endedAt: string | null;
}

export interface SeedBotMessage {
  id: string;
  conversationId: string;
  direction: BotDirection;
  body: string;
  providerMessageId: string | null;
  type: 'text' | 'template';
  templateId: string | null;
  intent: 'saldo' | 'cuotas' | 'proxima' | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface SeedData {
  users: SeedUser[];
  profiles: SeedProfile[];
  patients: SeedPatient[];
  doctors: SeedDoctor[];
  surgeryCatalog: SeedSurgeryCatalog[];
  surgeries: SeedSurgery[];
  surgeryDoctors: SeedSurgeryDoctor[];
  paymentPlans: SeedPaymentPlan[];
  installments: SeedInstallment[];
  payments: SeedPayment[];
  auditLogs: SeedAuditLog[];
  messageTemplates: SeedMessageTemplate[];
  whatsappDispatches: SeedWhatsappDispatch[];
  botConversations: SeedBotConversation[];
  botMessages: SeedBotMessage[];
}

// ---- Fixed v4-format UUID constants (explicit ids override the DB defaults) --

const USERS = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    name: 'Admin',
    role: UserRole.ADMIN,
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    name: 'Ana',
    role: UserRole.OFFICE,
  },
  {
    id: '10000000-0000-4000-8000-000000000003',
    name: 'Carlos',
    role: UserRole.OFFICE,
  },
  {
    id: '10000000-0000-4000-8000-000000000004',
    name: 'Daniel',
    role: UserRole.OFFICE,
  },
  {
    id: '10000000-0000-4000-8000-000000000005',
    name: 'Elena',
    role: UserRole.DOCTOR,
  },
  {
    id: '10000000-0000-4000-8000-000000000006',
    name: 'Fernando',
    role: UserRole.DOCTOR,
  },
  {
    id: '10000000-0000-4000-8000-000000000007',
    name: 'Gloria',
    role: UserRole.DOCTOR,
  },
  {
    id: '10000000-0000-4000-8000-000000000008',
    name: 'Hector',
    role: UserRole.PATIENT,
  },
  {
    id: '10000000-0000-4000-8000-000000000009',
    name: 'Isabel',
    role: UserRole.PATIENT,
  },
  {
    id: '10000000-0000-4000-8000-000000000010',
    name: 'Jorge',
    role: UserRole.PATIENT,
  },
];

const ADMIN_USER_ID = USERS[0].id;
const ANA_USER_ID = USERS[1].id;
const ELENA_USER_ID = USERS[4].id;
const FERNANDO_USER_ID = USERS[5].id;
const GLORIA_USER_ID = USERS[6].id;
const HECTOR_USER_ID = USERS[7].id;
const ISABEL_USER_ID = USERS[8].id;
const JORGE_USER_ID = USERS[9].id;

const PATIENT_1_ID = '20000000-0000-4000-8000-000000000001';
const PATIENT_2_ID = '20000000-0000-4000-8000-000000000002';
const PATIENT_3_ID = '20000000-0000-4000-8000-000000000003';
const PATIENT_4_ID = '20000000-0000-4000-8000-000000000004';
const PATIENT_5_ID = '20000000-0000-4000-8000-000000000005';
const PATIENT_6_ID = '20000000-0000-4000-8000-000000000006';

const DOCTOR_1_ID = '30000000-0000-4000-8000-000000000001';
const DOCTOR_2_ID = '30000000-0000-4000-8000-000000000002';
const DOCTOR_3_ID = '30000000-0000-4000-8000-000000000003';

const CATALOG_1_ID = '40000000-0000-4000-8000-000000000001';
const CATALOG_2_ID = '40000000-0000-4000-8000-000000000002';
const CATALOG_3_ID = '40000000-0000-4000-8000-000000000003';
const CATALOG_4_ID = '40000000-0000-4000-8000-000000000004';
const CATALOG_5_ID = '40000000-0000-4000-8000-000000000005';

const SURGERY_1_ID = '50000000-0000-4000-8000-000000000001';
const SURGERY_2_ID = '50000000-0000-4000-8000-000000000002';
const SURGERY_3_ID = '50000000-0000-4000-8000-000000000003';
const SURGERY_4_ID = '50000000-0000-4000-8000-000000000004';
const SURGERY_5_ID = '50000000-0000-4000-8000-000000000005';
const SURGERY_6_ID = '50000000-0000-4000-8000-000000000006';

const SURGERY_DOCTOR_IDS = [
  '51000000-0000-4000-8000-000000000001',
  '51000000-0000-4000-8000-000000000002',
  '51000000-0000-4000-8000-000000000003',
  '51000000-0000-4000-8000-000000000004',
  '51000000-0000-4000-8000-000000000005',
  '51000000-0000-4000-8000-000000000006',
  '51000000-0000-4000-8000-000000000007',
  '51000000-0000-4000-8000-000000000008',
  '51000000-0000-4000-8000-000000000009',
  '51000000-0000-4000-8000-000000000010',
  '51000000-0000-4000-8000-000000000011',
  '51000000-0000-4000-8000-000000000012',
  '51000000-0000-4000-8000-000000000013',
  '51000000-0000-4000-8000-000000000014',
  '51000000-0000-4000-8000-000000000015',
];

const PLAN_1_ID = '60000000-0000-4000-8000-000000000001';
const PLAN_2_ID = '60000000-0000-4000-8000-000000000002';
const PLAN_3_ID = '60000000-0000-4000-8000-000000000003';
const PLAN_4_ID = '60000000-0000-4000-8000-000000000004';
const PLAN_5_ID = '60000000-0000-4000-8000-000000000005';
const PLAN_6_ID = '60000000-0000-4000-8000-000000000006';

const INSTALLMENT_IDS = [
  '61000000-0000-4000-8000-000000000001',
  '61000000-0000-4000-8000-000000000002',
  '61000000-0000-4000-8000-000000000003',
  '61000000-0000-4000-8000-000000000004',
  '61000000-0000-4000-8000-000000000005',
  '61000000-0000-4000-8000-000000000006',
  '61000000-0000-4000-8000-000000000007',
  '61000000-0000-4000-8000-000000000008',
  '61000000-0000-4000-8000-000000000009',
  '61000000-0000-4000-8000-000000000010',
  '61000000-0000-4000-8000-000000000011',
  '61000000-0000-4000-8000-000000000012',
  '61000000-0000-4000-8000-000000000013',
  '61000000-0000-4000-8000-000000000014',
  '61000000-0000-4000-8000-000000000015',
  '61000000-0000-4000-8000-000000000016',
  '61000000-0000-4000-8000-000000000017',
  '61000000-0000-4000-8000-000000000018',
  '61000000-0000-4000-8000-000000000019',
  '61000000-0000-4000-8000-000000000020',
  '61000000-0000-4000-8000-000000000021',
  '61000000-0000-4000-8000-000000000022',
  '61000000-0000-4000-8000-000000000023',
  '61000000-0000-4000-8000-000000000024',
  '61000000-0000-4000-8000-000000000025',
  '61000000-0000-4000-8000-000000000026',
  '61000000-0000-4000-8000-000000000027',
  '61000000-0000-4000-8000-000000000028',
  '61000000-0000-4000-8000-000000000029',
  '61000000-0000-4000-8000-000000000030',
  '61000000-0000-4000-8000-000000000031',
  '61000000-0000-4000-8000-000000000032',
  '61000000-0000-4000-8000-000000000033',
  '61000000-0000-4000-8000-000000000034',
  '61000000-0000-4000-8000-000000000035',
  '61000000-0000-4000-8000-000000000036',
  '61000000-0000-4000-8000-000000000037',
  '61000000-0000-4000-8000-000000000038',
  '61000000-0000-4000-8000-000000000039',
  '61000000-0000-4000-8000-000000000040',
  '61000000-0000-4000-8000-000000000041',
  '61000000-0000-4000-8000-000000000042',
  '61000000-0000-4000-8000-000000000043',
  '61000000-0000-4000-8000-000000000044',
  '61000000-0000-4000-8000-000000000045',
  '61000000-0000-4000-8000-000000000046',
  '61000000-0000-4000-8000-000000000047',
  '61000000-0000-4000-8000-000000000048',
];

const PAYMENT_IDS = [
  '70000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000002',
  '70000000-0000-4000-8000-000000000003',
  '70000000-0000-4000-8000-000000000004',
  '70000000-0000-4000-8000-000000000005',
  '70000000-0000-4000-8000-000000000006',
  '70000000-0000-4000-8000-000000000007',
  '70000000-0000-4000-8000-000000000008',
  '70000000-0000-4000-8000-000000000009',
  '70000000-0000-4000-8000-000000000010',
  '70000000-0000-4000-8000-000000000011',
];

const AUDIT_LOG_IDS = [
  '80000000-0000-4000-8000-000000000001',
  '80000000-0000-4000-8000-000000000002',
  '80000000-0000-4000-8000-000000000003',
  '80000000-0000-4000-8000-000000000004',
  '80000000-0000-4000-8000-000000000005',
  '80000000-0000-4000-8000-000000000006',
  '80000000-0000-4000-8000-000000000007',
  '80000000-0000-4000-8000-000000000008',
  '80000000-0000-4000-8000-000000000009',
  '80000000-0000-4000-8000-000000000010',
  '80000000-0000-4000-8000-000000000011',
  '80000000-0000-4000-8000-000000000012',
];

const TEMPLATE_REMINDER_ID = '90000000-0000-4000-8000-000000000001';
const TEMPLATE_SURGERY_ID = '90000000-0000-4000-8000-000000000002';
const TEMPLATE_WELCOME_ID = '90000000-0000-4000-8000-000000000003';
const TEMPLATE_FEEDBACK_ID = '90000000-0000-4000-8000-000000000004';
const TEMPLATE_OVERDUE_ID = '90000000-0000-4000-8000-000000000005';

const DISPATCH_IDS = [
  'a1000000-0000-4000-8000-000000000001',
  'a1000000-0000-4000-8000-000000000002',
  'a1000000-0000-4000-8000-000000000003',
  'a1000000-0000-4000-8000-000000000004',
  'a1000000-0000-4000-8000-000000000005',
  'a1000000-0000-4000-8000-000000000006',
];

const CONVERSATION_IDS = [
  'b1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000002',
  'b1000000-0000-4000-8000-000000000003',
  'b1000000-0000-4000-8000-000000000004',
  'b1000000-0000-4000-8000-000000000005',
];

const BOT_MESSAGE_IDS = [
  'c1000000-0000-4000-8000-000000000001',
  'c1000000-0000-4000-8000-000000000002',
  'c1000000-0000-4000-8000-000000000003',
  'c1000000-0000-4000-8000-000000000004',
  'c1000000-0000-4000-8000-000000000005',
  'c1000000-0000-4000-8000-000000000006',
  'c1000000-0000-4000-8000-000000000007',
  'c1000000-0000-4000-8000-000000000008',
  'c1000000-0000-4000-8000-000000000009',
  'c1000000-0000-4000-8000-000000000010',
];

// ---- Static reference data --------------------------------------------------

const PROFILES: SeedProfile[] = [
  { userIndex: 0, gender: 'Femenino', photo: '', photoPublicId: '' },
  { userIndex: 1, gender: 'Femenino', photo: '', photoPublicId: '' },
  { userIndex: 2, gender: 'Masculino', photo: '', photoPublicId: '' },
  { userIndex: 4, gender: 'Femenino', photo: '', photoPublicId: '' },
  { userIndex: 5, gender: 'Masculino', photo: '', photoPublicId: '' },
  { userIndex: 7, gender: 'Masculino', photo: '', photoPublicId: '' },
];

const PATIENTS: SeedPatient[] = [
  {
    id: PATIENT_1_ID,
    userId: HECTOR_USER_ID,
    identityDocument: 'CI-1001',
    firstName: 'Hector',
    paternalLastName: 'Rojas',
    maternalLastName: 'Choque',
    birthDate: '1985-04-12',
    address: 'Av. Arce 1234, La Paz',
    phone: '+59170000001',
  },
  {
    id: PATIENT_2_ID,
    userId: ISABEL_USER_ID,
    identityDocument: 'CI-1002',
    firstName: 'Isabel',
    paternalLastName: 'Lopez',
    maternalLastName: 'Gutierrez',
    birthDate: '1990-11-03',
    address: 'Calle 21 de Calacoto, La Paz',
    phone: '+59170000002',
  },
  {
    id: PATIENT_3_ID,
    userId: JORGE_USER_ID,
    identityDocument: 'CI-1003',
    firstName: 'Jorge',
    paternalLastName: 'Mamani',
    maternalLastName: null,
    birthDate: '1978-02-27',
    address: 'Av. Blanco Galindo, Cochabamba',
    phone: '+59170000003',
  },
  {
    id: PATIENT_4_ID,
    userId: null,
    identityDocument: 'CI-1004',
    firstName: 'Marta',
    paternalLastName: 'Rios',
    maternalLastName: 'Flores',
    birthDate: '1988-07-19',
    address: 'Av. Heroinas 456, Cochabamba',
    phone: '+59170000004',
  },
  {
    id: PATIENT_5_ID,
    userId: null,
    identityDocument: 'CI-1005',
    firstName: 'Ruben',
    paternalLastName: 'Quispe',
    maternalLastName: null,
    birthDate: '1995-09-30',
    address: 'Calle Libertad, Santa Cruz',
    phone: '+59170000005',
  },
  {
    id: PATIENT_6_ID,
    userId: null,
    identityDocument: 'CI-1006',
    firstName: 'Lucia',
    paternalLastName: 'Vargas',
    maternalLastName: 'Salinas',
    birthDate: '1982-12-08',
    address: 'Av. Monsenor Rivero, Santa Cruz',
    phone: '+59170000006',
  },
];

const DOCTORS: SeedDoctor[] = [
  {
    id: DOCTOR_1_ID,
    userId: ELENA_USER_ID,
    specialty: 'Cirugia general',
    professionalLicense: 'MED-301-1234',
    firstName: 'Elena',
    paternalLastName: 'Mendoza',
    maternalLastName: 'Quiroga',
    phone: '+59171000001',
  },
  {
    id: DOCTOR_2_ID,
    userId: FERNANDO_USER_ID,
    specialty: 'Anestesiologia',
    professionalLicense: 'MED-302-5678',
    firstName: 'Fernando',
    paternalLastName: 'Aguirre',
    maternalLastName: 'Villca',
    phone: '+59171000002',
  },
  {
    id: DOCTOR_3_ID,
    userId: GLORIA_USER_ID,
    specialty: 'Traumatologia y ortopedia',
    professionalLicense: 'MED-303-9012',
    firstName: 'Gloria',
    paternalLastName: 'Camacho',
    maternalLastName: null,
    phone: '+59171000003',
  },
];

const SURGERY_CATALOG: SeedSurgeryCatalog[] = [
  {
    id: CATALOG_1_ID,
    name: 'Cateterismo cardiaco',
    description:
      'Procedimiento de cateterismo cardiaco diagnostico y terapeutico.',
    baseCost: '45000.00',
  },
  {
    id: CATALOG_2_ID,
    name: 'Artroscopia de rodilla',
    description: 'Cirugia artroscopica de rodilla.',
    baseCost: '35000.00',
  },
  {
    id: CATALOG_3_ID,
    name: 'Apendicectomia',
    description: 'Extraccion quirurgica del apendice.',
    baseCost: '28000.00',
  },
  {
    id: CATALOG_4_ID,
    name: 'Colecistectomia',
    description: 'Extraccion de la vesicula biliar por via laparoscopica.',
    baseCost: '32500.00',
  },
  {
    id: CATALOG_5_ID,
    name: 'Cesarea',
    description: 'Parto por cesarea programada.',
    baseCost: '42000.00',
  },
];

const SURGERIES: SeedSurgery[] = [
  {
    id: SURGERY_1_ID,
    patientId: PATIENT_1_ID,
    surgeryCatalogId: CATALOG_1_ID,
    scheduledDate: '2026-05-15',
    totalCost: '45000.00',
    status: SurgeryStatus.PERFORMED,
    notes: 'Paciente dado de alta sin complicaciones.',
  },
  {
    id: SURGERY_2_ID,
    patientId: PATIENT_2_ID,
    surgeryCatalogId: CATALOG_2_ID,
    scheduledDate: '2026-06-20',
    totalCost: '35000.00',
    status: SurgeryStatus.PERFORMED,
    notes: null,
  },
  {
    id: SURGERY_3_ID,
    patientId: PATIENT_3_ID,
    surgeryCatalogId: CATALOG_3_ID,
    scheduledDate: '2026-06-01',
    totalCost: '28000.00',
    status: SurgeryStatus.PERFORMED,
    notes: null,
  },
  {
    id: SURGERY_4_ID,
    patientId: PATIENT_4_ID,
    surgeryCatalogId: CATALOG_4_ID,
    scheduledDate: '2026-08-20',
    totalCost: '32500.00',
    status: SurgeryStatus.SCHEDULED,
    notes: null,
  },
  {
    id: SURGERY_5_ID,
    patientId: PATIENT_5_ID,
    surgeryCatalogId: CATALOG_5_ID,
    scheduledDate: '2026-07-05',
    totalCost: '42000.00',
    status: SurgeryStatus.CANCELLED,
    notes: 'Cancelada por solicitud del paciente.',
  },
  {
    id: SURGERY_6_ID,
    patientId: PATIENT_6_ID,
    surgeryCatalogId: CATALOG_2_ID,
    scheduledDate: '2026-10-02',
    totalCost: '36000.00',
    status: SurgeryStatus.SCHEDULED,
    notes: null,
  },
];

const SURGERY_DOCTORS: SeedSurgeryDoctor[] = [
  {
    id: SURGERY_DOCTOR_IDS[0],
    surgeryId: SURGERY_1_ID,
    doctorId: DOCTOR_1_ID,
    role: SurgeryDoctorRole.PRINCIPAL,
  },
  {
    id: SURGERY_DOCTOR_IDS[1],
    surgeryId: SURGERY_1_ID,
    doctorId: DOCTOR_2_ID,
    role: SurgeryDoctorRole.ASSISTANT,
  },
  {
    id: SURGERY_DOCTOR_IDS[2],
    surgeryId: SURGERY_1_ID,
    doctorId: DOCTOR_3_ID,
    role: SurgeryDoctorRole.ANESTHESIOLOGIST,
  },
  {
    id: SURGERY_DOCTOR_IDS[3],
    surgeryId: SURGERY_2_ID,
    doctorId: DOCTOR_2_ID,
    role: SurgeryDoctorRole.PRINCIPAL,
  },
  {
    id: SURGERY_DOCTOR_IDS[4],
    surgeryId: SURGERY_2_ID,
    doctorId: DOCTOR_3_ID,
    role: SurgeryDoctorRole.ASSISTANT,
  },
  {
    id: SURGERY_DOCTOR_IDS[5],
    surgeryId: SURGERY_2_ID,
    doctorId: DOCTOR_1_ID,
    role: SurgeryDoctorRole.ANESTHESIOLOGIST,
  },
  {
    id: SURGERY_DOCTOR_IDS[6],
    surgeryId: SURGERY_3_ID,
    doctorId: DOCTOR_3_ID,
    role: SurgeryDoctorRole.PRINCIPAL,
  },
  {
    id: SURGERY_DOCTOR_IDS[7],
    surgeryId: SURGERY_3_ID,
    doctorId: DOCTOR_1_ID,
    role: SurgeryDoctorRole.ASSISTANT,
  },
  {
    id: SURGERY_DOCTOR_IDS[8],
    surgeryId: SURGERY_4_ID,
    doctorId: DOCTOR_1_ID,
    role: SurgeryDoctorRole.PRINCIPAL,
  },
  {
    id: SURGERY_DOCTOR_IDS[9],
    surgeryId: SURGERY_4_ID,
    doctorId: DOCTOR_3_ID,
    role: SurgeryDoctorRole.ANESTHESIOLOGIST,
  },
  {
    id: SURGERY_DOCTOR_IDS[10],
    surgeryId: SURGERY_5_ID,
    doctorId: DOCTOR_2_ID,
    role: SurgeryDoctorRole.PRINCIPAL,
  },
  {
    id: SURGERY_DOCTOR_IDS[11],
    surgeryId: SURGERY_5_ID,
    doctorId: DOCTOR_1_ID,
    role: SurgeryDoctorRole.ASSISTANT,
  },
  {
    id: SURGERY_DOCTOR_IDS[12],
    surgeryId: SURGERY_6_ID,
    doctorId: DOCTOR_3_ID,
    role: SurgeryDoctorRole.PRINCIPAL,
  },
  {
    id: SURGERY_DOCTOR_IDS[13],
    surgeryId: SURGERY_6_ID,
    doctorId: DOCTOR_2_ID,
    role: SurgeryDoctorRole.ASSISTANT,
  },
  {
    id: SURGERY_DOCTOR_IDS[14],
    surgeryId: SURGERY_6_ID,
    doctorId: DOCTOR_1_ID,
    role: SurgeryDoctorRole.ANESTHESIOLOGIST,
  },
];

const PAYMENT_PLAN_SPECS: SeedPaymentPlan[] = [
  {
    id: PLAN_1_ID,
    surgeryId: SURGERY_1_ID,
    type: PaymentPlanType.CREDIT,
    downPayment: '5000.00',
    monthlyInterestRate: '2.00',
    installmentCount: 12,
    startDate: '2026-06-01',
    status: PaymentPlanStatus.ACTIVE,
    installmentOverrides: [
      { number: 1, status: InstallmentStatus.PAID },
      { number: 2, status: InstallmentStatus.PARTIAL, paidAmount: '1500.00' },
    ],
    amortizations: ['3000.00'],
  },
  {
    id: PLAN_2_ID,
    surgeryId: SURGERY_2_ID,
    type: PaymentPlanType.CREDIT,
    downPayment: '5000.00',
    monthlyInterestRate: '2.00',
    installmentCount: 6,
    startDate: '2026-07-01',
    status: PaymentPlanStatus.ACTIVE,
    installmentOverrides: [{ number: 1, status: InstallmentStatus.PAID }],
    amortizations: [],
  },
  {
    id: PLAN_3_ID,
    surgeryId: SURGERY_3_ID,
    type: PaymentPlanType.UPFRONT,
    downPayment: '0.00',
    monthlyInterestRate: '0.00',
    installmentCount: 1,
    startDate: '2026-06-01',
    status: PaymentPlanStatus.COMPLETED,
    installmentOverrides: [{ number: 1, status: InstallmentStatus.PAID }],
    amortizations: [],
  },
  {
    id: PLAN_4_ID,
    surgeryId: SURGERY_4_ID,
    type: PaymentPlanType.CREDIT,
    downPayment: '6000.00',
    monthlyInterestRate: '2.00',
    installmentCount: 18,
    startDate: '2026-09-01',
    status: PaymentPlanStatus.ACTIVE,
    installmentOverrides: [],
    amortizations: [],
  },
  {
    id: PLAN_5_ID,
    surgeryId: SURGERY_5_ID,
    type: PaymentPlanType.UPFRONT,
    downPayment: '0.00',
    monthlyInterestRate: '0.00',
    installmentCount: 1,
    startDate: '2026-07-01',
    status: PaymentPlanStatus.CANCELLED,
    installmentOverrides: [{ number: 1, status: InstallmentStatus.CANCELLED }],
    amortizations: [],
  },
  {
    id: PLAN_6_ID,
    surgeryId: SURGERY_6_ID,
    type: PaymentPlanType.CREDIT,
    downPayment: '4000.00',
    monthlyInterestRate: '2.00',
    installmentCount: 10,
    startDate: '2026-10-01',
    status: PaymentPlanStatus.ACTIVE,
    installmentOverrides: [],
    amortizations: [],
  },
];

// ---- Generated schedule data (deterministic French amortization) ------------

const SURGERY_TOTAL_COST = new Map(
  SURGERIES.map((surgery) => [surgery.id, surgery.totalCost]),
);

function toUtcDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildInstallments(): SeedInstallment[] {
  const installments: SeedInstallment[] = [];
  let idIndex = 0;

  for (const spec of PAYMENT_PLAN_SPECS) {
    const surgeryTotal = SURGERY_TOTAL_COST.get(spec.surgeryId);
    if (!surgeryTotal) {
      throw new Error(`Seed plan references unknown surgery ${spec.surgeryId}`);
    }
    const financedAmount = new Decimal(surgeryTotal)
      .minus(spec.downPayment)
      .toFixed(2);

    const lines = financingEngine.generateFrenchAmortizationSchedule(
      financedAmount,
      spec.monthlyInterestRate,
      spec.installmentCount,
      toUtcDate(spec.startDate),
    );

    for (const line of lines) {
      const override = spec.installmentOverrides.find(
        (entry) => entry.number === line.installmentNumber,
      );
      const status = override?.status ?? InstallmentStatus.PENDING;
      const paidAmount =
        status === InstallmentStatus.PAID
          ? line.totalAmount
          : status === InstallmentStatus.PARTIAL
            ? (override?.paidAmount ?? '0.00')
            : '0.00';

      installments.push({
        id: INSTALLMENT_IDS[idIndex++],
        paymentPlanId: spec.id,
        installmentNumber: line.installmentNumber,
        principalAmount: line.principalAmount,
        interestAmount: line.interestAmount,
        totalAmount: line.totalAmount,
        paidAmount,
        dueDate: toDateString(line.dueDate),
        status,
      });
    }
  }

  return installments;
}

function buildOutstandingBalances(): Map<string, string> {
  const balances = new Map<string, string>();
  const installmentsByPlan = new Map<string, SeedInstallment[]>();
  for (const installment of buildInstallments()) {
    const planInstallments =
      installmentsByPlan.get(installment.paymentPlanId) ?? [];
    planInstallments.push(installment);
    installmentsByPlan.set(installment.paymentPlanId, planInstallments);
  }

  for (const spec of PAYMENT_PLAN_SPECS) {
    const surgeryTotal = SURGERY_TOTAL_COST.get(spec.surgeryId);
    if (!surgeryTotal) {
      throw new Error(`Seed plan references unknown surgery ${spec.surgeryId}`);
    }
    const financedAmount = new Decimal(surgeryTotal)
      .minus(spec.downPayment)
      .toFixed(2);

    if (spec.status === PaymentPlanStatus.CANCELLED) {
      // A cancelled plan owes nothing: no confirmed payment reduced it.
      balances.set(spec.id, '0.00');
      continue;
    }

    const paidPrincipal = (installmentsByPlan.get(spec.id) ?? [])
      .filter((installment) => installment.status === InstallmentStatus.PAID)
      .reduce(
        (sum, installment) => sum.plus(installment.principalAmount),
        new Decimal(0),
      );
    const partialPaid = (installmentsByPlan.get(spec.id) ?? [])
      .filter((installment) => installment.status === InstallmentStatus.PARTIAL)
      .reduce(
        (sum, installment) => sum.plus(installment.paidAmount),
        new Decimal(0),
      );
    const amortized = spec.amortizations.reduce(
      (sum, amount) => sum.plus(amount),
      new Decimal(0),
    );

    balances.set(
      spec.id,
      new Decimal(financedAmount)
        .minus(paidPrincipal)
        .minus(partialPaid)
        .minus(amortized)
        .toFixed(2),
    );
  }

  return balances;
}

const OUTSTANDING_BALANCES = buildOutstandingBalances();

// ---- Payments, audit, templates, whatsapp and bot data ----------------------

const PAYMENTS: SeedPayment[] = [
  {
    id: PAYMENT_IDS[0],
    paymentPlanId: PLAN_1_ID,
    installmentId: null,
    patientUserId: null,
    recordedByUserId: ANA_USER_ID,
    paymentMethod: 'cash',
    amount: '5000.00',
    type: PaymentType.DOWN_PAYMENT,
    amortizationMode: null,
    paidAt: '2026-06-01T14:30:00.000Z',
    status: PaymentStatus.CONFIRMED,
  },
  {
    id: PAYMENT_IDS[1],
    paymentPlanId: PLAN_1_ID,
    installmentId: INSTALLMENT_IDS[0],
    patientUserId: null,
    recordedByUserId: ANA_USER_ID,
    paymentMethod: 'bank_transfer',
    amount: '3782.38',
    type: PaymentType.INSTALLMENT_PAYMENT,
    amortizationMode: null,
    paidAt: '2026-07-01T10:00:00.000Z',
    status: PaymentStatus.CONFIRMED,
  },
  {
    id: PAYMENT_IDS[2],
    paymentPlanId: PLAN_1_ID,
    installmentId: INSTALLMENT_IDS[1],
    patientUserId: null,
    recordedByUserId: ANA_USER_ID,
    paymentMethod: 'qr',
    amount: '1500.00',
    type: PaymentType.INSTALLMENT_PAYMENT,
    amortizationMode: null,
    paidAt: '2026-07-15T16:45:00.000Z',
    status: PaymentStatus.CONFIRMED,
  },
  {
    id: PAYMENT_IDS[3],
    paymentPlanId: PLAN_1_ID,
    installmentId: null,
    patientUserId: null,
    recordedByUserId: ADMIN_USER_ID,
    paymentMethod: 'bank_transfer',
    amount: '3000.00',
    type: PaymentType.PRINCIPAL_AMORTIZATION,
    amortizationMode: AmortizationMode.REDUCE_INSTALLMENT,
    paidAt: '2026-07-20T09:15:00.000Z',
    status: PaymentStatus.CONFIRMED,
  },
  {
    id: PAYMENT_IDS[4],
    paymentPlanId: PLAN_2_ID,
    installmentId: null,
    patientUserId: null,
    recordedByUserId: ANA_USER_ID,
    paymentMethod: 'card',
    amount: '5000.00',
    type: PaymentType.DOWN_PAYMENT,
    amortizationMode: null,
    paidAt: '2026-07-01T11:00:00.000Z',
    status: PaymentStatus.CONFIRMED,
  },
  {
    id: PAYMENT_IDS[5],
    paymentPlanId: PLAN_2_ID,
    installmentId: INSTALLMENT_IDS[12],
    patientUserId: null,
    recordedByUserId: ANA_USER_ID,
    paymentMethod: 'qr',
    amount: '5355.77',
    type: PaymentType.INSTALLMENT_PAYMENT,
    amortizationMode: null,
    paidAt: '2026-08-01T09:30:00.000Z',
    status: PaymentStatus.CONFIRMED,
  },
  {
    id: PAYMENT_IDS[6],
    paymentPlanId: PLAN_2_ID,
    installmentId: INSTALLMENT_IDS[13],
    patientUserId: ISABEL_USER_ID,
    recordedByUserId: ANA_USER_ID,
    paymentMethod: 'qr',
    amount: '5355.77',
    type: PaymentType.INSTALLMENT_PAYMENT,
    amortizationMode: null,
    paidAt: '2026-08-03T18:20:00.000Z',
    status: PaymentStatus.PENDING_CONFIRMATION,
  },
  {
    id: PAYMENT_IDS[7],
    paymentPlanId: PLAN_3_ID,
    installmentId: INSTALLMENT_IDS[18],
    patientUserId: null,
    recordedByUserId: ANA_USER_ID,
    paymentMethod: 'bank_transfer',
    amount: '28000.00',
    type: PaymentType.INSTALLMENT_PAYMENT,
    amortizationMode: null,
    paidAt: '2026-06-01T15:00:00.000Z',
    status: PaymentStatus.CONFIRMED,
  },
  {
    id: PAYMENT_IDS[8],
    paymentPlanId: PLAN_4_ID,
    installmentId: null,
    patientUserId: null,
    recordedByUserId: ANA_USER_ID,
    paymentMethod: 'cash',
    amount: '6000.00',
    type: PaymentType.DOWN_PAYMENT,
    amortizationMode: null,
    paidAt: '2026-09-01T10:00:00.000Z',
    status: PaymentStatus.CONFIRMED,
  },
  {
    id: PAYMENT_IDS[9],
    paymentPlanId: PLAN_4_ID,
    installmentId: INSTALLMENT_IDS[19],
    patientUserId: null,
    recordedByUserId: ANA_USER_ID,
    paymentMethod: 'qr',
    amount: '1700.00',
    type: PaymentType.INSTALLMENT_PAYMENT,
    amortizationMode: null,
    paidAt: '2026-09-02T13:00:00.000Z',
    status: PaymentStatus.REJECTED,
  },
  {
    id: PAYMENT_IDS[10],
    paymentPlanId: PLAN_6_ID,
    installmentId: null,
    patientUserId: null,
    recordedByUserId: ANA_USER_ID,
    paymentMethod: 'card',
    amount: '4000.00',
    type: PaymentType.DOWN_PAYMENT,
    amortizationMode: null,
    paidAt: '2026-10-01T10:00:00.000Z',
    status: PaymentStatus.CONFIRMED,
  },
];

const AUDIT_LOGS: SeedAuditLog[] = [
  {
    id: AUDIT_LOG_IDS[0],
    userId: ANA_USER_ID,
    action: 'payment_plan.created',
    tableName: 'payment_plans',
    recordId: PLAN_1_ID,
    previousData: null,
    newData: {
      type: 'credit',
      financed_amount: '40000.00',
      installment_count: 12,
    },
    createdAt: '2026-06-01T14:30:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[1],
    userId: ANA_USER_ID,
    action: 'payment.confirmed',
    tableName: 'payments',
    recordId: PAYMENT_IDS[1],
    previousData: { status: 'pending_confirmation' },
    newData: { status: 'confirmed' },
    createdAt: '2026-07-01T10:00:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[2],
    userId: ANA_USER_ID,
    action: 'payment.confirmed',
    tableName: 'payments',
    recordId: PAYMENT_IDS[2],
    previousData: { status: 'pending_confirmation' },
    newData: { status: 'confirmed' },
    createdAt: '2026-07-15T16:45:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[3],
    userId: ADMIN_USER_ID,
    action: 'payment.confirmed',
    tableName: 'payments',
    recordId: PAYMENT_IDS[3],
    previousData: { status: 'pending_confirmation' },
    newData: { status: 'confirmed', amortization_mode: 'reduce_installment' },
    createdAt: '2026-07-20T09:15:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[4],
    userId: ADMIN_USER_ID,
    action: 'surgery.status_changed',
    tableName: 'surgeries',
    recordId: SURGERY_1_ID,
    previousData: { status: 'scheduled' },
    newData: { status: 'performed' },
    createdAt: '2026-05-20T10:00:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[5],
    userId: ANA_USER_ID,
    action: 'payment_plan.created',
    tableName: 'payment_plans',
    recordId: PLAN_2_ID,
    previousData: null,
    newData: {
      type: 'credit',
      financed_amount: '30000.00',
      installment_count: 6,
    },
    createdAt: '2026-07-01T11:00:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[6],
    userId: ANA_USER_ID,
    action: 'payment_plan.created',
    tableName: 'payment_plans',
    recordId: PLAN_3_ID,
    previousData: null,
    newData: {
      type: 'upfront',
      financed_amount: '28000.00',
      installment_count: 1,
    },
    createdAt: '2026-06-01T15:00:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[7],
    userId: ANA_USER_ID,
    action: 'payment.rejected',
    tableName: 'payments',
    recordId: PAYMENT_IDS[9],
    previousData: { status: 'pending_confirmation' },
    newData: { status: 'rejected' },
    createdAt: '2026-09-03T09:00:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[8],
    userId: ANA_USER_ID,
    action: 'whatsapp_dispatch.created',
    tableName: 'whatsapp_dispatches',
    recordId: DISPATCH_IDS[3],
    previousData: null,
    newData: { status: 'queued' },
    createdAt: '2026-08-06T08:00:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[9],
    userId: ANA_USER_ID,
    action: 'whatsapp_dispatch.failed',
    tableName: 'whatsapp_dispatches',
    recordId: DISPATCH_IDS[4],
    previousData: { status: 'queued' },
    newData: {
      status: 'failed',
      provider_error: 'ERR 80009: recipient not reachable',
    },
    createdAt: '2026-08-05T17:30:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[10],
    userId: ADMIN_USER_ID,
    action: 'message_template.submitted',
    tableName: 'message_templates',
    recordId: TEMPLATE_SURGERY_ID,
    previousData: { status: 'draft' },
    newData: { status: 'submitted' },
    createdAt: '2026-07-20T12:00:00.000Z',
  },
  {
    id: AUDIT_LOG_IDS[11],
    userId: null,
    action: 'patient.identified',
    tableName: 'bot_conversations',
    recordId: CONVERSATION_IDS[0],
    previousData: { state: 'unidentified' },
    newData: { state: 'identified', patient_id: PATIENT_1_ID },
    createdAt: '2026-08-01T09:00:00.000Z',
  },
];

const MESSAGE_TEMPLATES: SeedMessageTemplate[] = [
  {
    id: TEMPLATE_REMINDER_ID,
    name: 'payment_reminder',
    category: TemplateCategory.UTILITY,
    language: 'es',
    bodyTemplate:
      'Estimado(a) {{1}}, le recordamos que su cuota {{2}} vence el {{3}}. Por favor realice su pago a tiempo.',
    sampleVariables: { '1': 'Hector Rojas', '2': '3', '3': '2026-09-01' },
    status: TemplateStatus.APPROVED,
    providerTemplateId: 'HBT_PAYMENT_REMINDER',
    providerStatus: 'approved',
    isActive: true,
    createdByUserId: ADMIN_USER_ID,
  },
  {
    // Hermana de payment_reminder para cuotas YA vencidas: el job diario de
    // recordatorios resuelve las plantillas por nombre y necesita las dos.
    id: TEMPLATE_OVERDUE_ID,
    name: 'payment_overdue',
    category: TemplateCategory.UTILITY,
    language: 'es',
    bodyTemplate:
      'Estimado(a) {{1}}, su cuota {{2}} vencio el {{3}}. Comuniquese con nosotros para regularizar su pago.',
    sampleVariables: { '1': 'Hector Rojas', '2': '2', '3': '2026-07-01' },
    status: TemplateStatus.APPROVED,
    providerTemplateId: 'HBT_PAYMENT_OVERDUE',
    providerStatus: 'approved',
    isActive: true,
    createdByUserId: ADMIN_USER_ID,
  },
  {
    id: TEMPLATE_SURGERY_ID,
    name: 'surgery_confirmation',
    category: TemplateCategory.UTILITY,
    language: 'es',
    bodyTemplate:
      'Estimado(a) {{1}}, su cirugia de {{2}} esta programada para el {{3}}. Presentese 2 horas antes.',
    sampleVariables: {
      '1': 'Marta Rios',
      '2': 'Colecistectomia',
      '3': '2026-08-20',
    },
    status: TemplateStatus.SUBMITTED,
    providerTemplateId: 'HBT_SURGERY_CONFIRM',
    providerStatus: 'pending',
    isActive: false,
    createdByUserId: ADMIN_USER_ID,
  },
  {
    id: TEMPLATE_WELCOME_ID,
    name: 'welcome_message',
    category: TemplateCategory.MARKETING,
    language: 'es',
    bodyTemplate:
      'Bienvenido(a) {{1}} a la Clinica La Paz. Su credito fue aprobado por {{2}}.',
    sampleVariables: { '1': 'Lucia Vargas', '2': 'Bs 32000.00' },
    status: TemplateStatus.APPROVED,
    providerTemplateId: 'MKT_WELCOME',
    providerStatus: 'approved',
    isActive: true,
    createdByUserId: ADMIN_USER_ID,
  },
  {
    id: TEMPLATE_FEEDBACK_ID,
    name: 'feedback_survey',
    category: TemplateCategory.MARKETING,
    language: 'es',
    bodyTemplate:
      'Estimado(a) {{1}}, cuentenos como fue su experiencia en {{2}}.',
    sampleVariables: {},
    status: TemplateStatus.DRAFT,
    providerTemplateId: null,
    providerStatus: null,
    isActive: false,
    createdByUserId: ANA_USER_ID,
  },
];

const WHATSAPP_DISPATCHES: SeedWhatsappDispatch[] = [
  {
    id: DISPATCH_IDS[0],
    patientId: PATIENT_1_ID,
    templateId: TEMPLATE_REMINDER_ID,
    status: DispatchStatus.DELIVERED,
    sendAttempts: 1,
    providerMessageId: 'wamid.disp.1001',
    providerError: null,
    payload: { '1': 'Hector Rojas', '2': '1', '3': '2026-07-01' },
    phone: '+59170000001',
    dedupeKey: 'reminder-plan1-inst1',
    createdByUserId: ADMIN_USER_ID,
    sentAt: '2026-07-01T08:00:00.000Z',
  },
  {
    id: DISPATCH_IDS[1],
    patientId: PATIENT_2_ID,
    templateId: TEMPLATE_REMINDER_ID,
    status: DispatchStatus.SENT,
    sendAttempts: 1,
    providerMessageId: 'wamid.disp.1002',
    providerError: null,
    payload: { '1': 'Isabel Lopez', '2': '1', '3': '2026-08-01' },
    phone: '+59170000002',
    dedupeKey: 'reminder-plan2-inst1',
    createdByUserId: ANA_USER_ID,
    sentAt: '2026-08-01T08:00:00.000Z',
  },
  {
    id: DISPATCH_IDS[2],
    patientId: PATIENT_3_ID,
    templateId: TEMPLATE_SURGERY_ID,
    status: DispatchStatus.DELIVERED,
    sendAttempts: 1,
    providerMessageId: 'wamid.disp.1003',
    providerError: null,
    payload: { '1': 'Jorge Mamani', '2': 'Apendicectomia', '3': '2026-06-01' },
    phone: '+59170000003',
    dedupeKey: 'surgery-conf-s3',
    createdByUserId: ANA_USER_ID,
    sentAt: '2026-05-25T09:00:00.000Z',
  },
  {
    id: DISPATCH_IDS[3],
    patientId: PATIENT_4_ID,
    templateId: TEMPLATE_SURGERY_ID,
    status: DispatchStatus.QUEUED,
    sendAttempts: 0,
    providerMessageId: null,
    providerError: null,
    payload: { '1': 'Marta Rios', '2': 'Colecistectomia', '3': '2026-08-20' },
    phone: '+59170000004',
    dedupeKey: 'surgery-conf-s4',
    createdByUserId: ANA_USER_ID,
    sentAt: null,
  },
  {
    id: DISPATCH_IDS[4],
    patientId: PATIENT_5_ID,
    templateId: TEMPLATE_WELCOME_ID,
    status: DispatchStatus.FAILED,
    sendAttempts: 3,
    providerMessageId: null,
    providerError: 'ERR 80009: recipient not reachable',
    payload: { '1': 'Ruben Quispe', '2': 'Bs 42000.00' },
    phone: '+59170000005',
    dedupeKey: 'welcome-s5',
    createdByUserId: ANA_USER_ID,
    sentAt: null,
  },
  {
    id: DISPATCH_IDS[5],
    patientId: PATIENT_6_ID,
    templateId: TEMPLATE_REMINDER_ID,
    status: DispatchStatus.QUEUED,
    sendAttempts: 0,
    providerMessageId: null,
    providerError: null,
    payload: { '1': 'Lucia Vargas', '2': '1', '3': '2026-11-01' },
    phone: '+59170000006',
    dedupeKey: 'reminder-plan6-inst1',
    createdByUserId: ADMIN_USER_ID,
    sentAt: null,
  },
];

const BOT_CONVERSATIONS: SeedBotConversation[] = [
  {
    id: CONVERSATION_IDS[0],
    waId: '+59170000001',
    patientId: PATIENT_1_ID,
    state: BotConversationState.IDENTIFIED,
    failedAttempts: 0,
    lockoutUntil: null,
    lastActivityAt: '2026-08-02T10:10:00.000Z',
    startedAt: '2026-06-15T09:00:00.000Z',
    endedAt: null,
  },
  {
    id: CONVERSATION_IDS[1],
    waId: '+59170000002',
    patientId: PATIENT_2_ID,
    state: BotConversationState.IDENTIFIED,
    failedAttempts: 0,
    lockoutUntil: null,
    lastActivityAt: '2026-08-03T18:25:00.000Z',
    startedAt: '2026-07-10T12:00:00.000Z',
    endedAt: null,
  },
  {
    id: CONVERSATION_IDS[2],
    waId: '+59170000007',
    patientId: null,
    state: BotConversationState.UNIDENTIFIED,
    failedAttempts: 0,
    lockoutUntil: null,
    lastActivityAt: '2026-08-04T11:30:00.000Z',
    startedAt: '2026-08-04T11:30:00.000Z',
    endedAt: null,
  },
  {
    id: CONVERSATION_IDS[3],
    waId: '+59170000008',
    patientId: null,
    state: BotConversationState.AWAITING_DOCUMENT,
    failedAttempts: 0,
    lockoutUntil: null,
    lastActivityAt: '2026-08-05T15:00:00.000Z',
    startedAt: '2026-08-05T15:00:00.000Z',
    endedAt: null,
  },
  {
    id: CONVERSATION_IDS[4],
    waId: '+59170000009',
    patientId: null,
    state: BotConversationState.UNIDENTIFIED,
    failedAttempts: 3,
    lockoutUntil: '2026-08-08T00:00:00.000Z',
    lastActivityAt: '2026-08-05T19:00:00.000Z',
    startedAt: '2026-08-05T18:40:00.000Z',
    endedAt: null,
  },
];

const BOT_MESSAGES: SeedBotMessage[] = [
  {
    id: BOT_MESSAGE_IDS[0],
    conversationId: CONVERSATION_IDS[0],
    direction: BotDirection.INBOUND,
    body: 'Hola, quiero saber mi saldo',
    providerMessageId: 'wamid.in.2001',
    type: 'text',
    templateId: null,
    intent: 'saldo',
    metadata: { status: 'received' },
    createdAt: '2026-08-02T10:00:00.000Z',
  },
  {
    id: BOT_MESSAGE_IDS[1],
    conversationId: CONVERSATION_IDS[0],
    direction: BotDirection.OUTBOUND,
    body: 'Su saldo pendiente es de 32517.62 Bs. Su proxima cuota vence el 2026-09-01.',
    providerMessageId: 'wamid.out.2001',
    type: 'text',
    templateId: null,
    intent: null,
    metadata: { status: 'sent' },
    createdAt: '2026-08-02T10:00:05.000Z',
  },
  {
    id: BOT_MESSAGE_IDS[2],
    conversationId: CONVERSATION_IDS[0],
    direction: BotDirection.INBOUND,
    body: 'Cuando es mi proxima cuota?',
    providerMessageId: 'wamid.in.2002',
    type: 'text',
    templateId: null,
    intent: 'proxima',
    metadata: { status: 'received' },
    createdAt: '2026-08-02T10:05:00.000Z',
  },
  {
    id: BOT_MESSAGE_IDS[3],
    conversationId: CONVERSATION_IDS[0],
    direction: BotDirection.OUTBOUND,
    body: 'Estimado(a) Hector Rojas, le recordamos que su cuota 3 vence el 2026-09-01.',
    providerMessageId: 'wamid.out.2002',
    type: 'template',
    templateId: TEMPLATE_REMINDER_ID,
    intent: null,
    metadata: { status: 'sent' },
    createdAt: '2026-08-02T10:05:10.000Z',
  },
  {
    id: BOT_MESSAGE_IDS[4],
    conversationId: CONVERSATION_IDS[1],
    direction: BotDirection.INBOUND,
    body: 'Cuando vence mi cuota?',
    providerMessageId: 'wamid.in.2003',
    type: 'text',
    templateId: null,
    intent: 'cuotas',
    metadata: { status: 'received' },
    createdAt: '2026-08-03T18:20:00.000Z',
  },
  {
    id: BOT_MESSAGE_IDS[5],
    conversationId: CONVERSATION_IDS[1],
    direction: BotDirection.OUTBOUND,
    body: 'Su cuota 1 vence el 2026-08-01 y se encuentra pagada.',
    providerMessageId: 'wamid.out.2003',
    type: 'text',
    templateId: null,
    intent: null,
    metadata: { status: 'sent' },
    createdAt: '2026-08-03T18:20:05.000Z',
  },
  {
    id: BOT_MESSAGE_IDS[6],
    conversationId: CONVERSATION_IDS[2],
    direction: BotDirection.INBOUND,
    body: 'Hola',
    providerMessageId: 'wamid.in.2004',
    type: 'text',
    templateId: null,
    intent: null,
    metadata: { status: 'received' },
    createdAt: '2026-08-04T11:30:00.000Z',
  },
  {
    id: BOT_MESSAGE_IDS[7],
    conversationId: CONVERSATION_IDS[3],
    direction: BotDirection.INBOUND,
    body: 'Quiero registrarme, mi carnet es CI-1001',
    providerMessageId: null,
    type: 'text',
    templateId: null,
    intent: null,
    metadata: { status: 'received' },
    createdAt: '2026-08-05T15:00:00.000Z',
  },
  {
    id: BOT_MESSAGE_IDS[8],
    conversationId: CONVERSATION_IDS[3],
    direction: BotDirection.OUTBOUND,
    body: 'Para identificarse envie su numero de carnet de identidad.',
    providerMessageId: 'wamid.out.2004',
    type: 'text',
    templateId: null,
    intent: null,
    metadata: { status: 'sent' },
    createdAt: '2026-08-05T15:00:05.000Z',
  },
  {
    id: BOT_MESSAGE_IDS[9],
    conversationId: CONVERSATION_IDS[4],
    direction: BotDirection.INBOUND,
    body: 'Cuantas cuotas me quedan?',
    providerMessageId: null,
    type: 'text',
    templateId: null,
    intent: 'cuotas',
    metadata: { status: 'received' },
    createdAt: '2026-08-05T19:00:00.000Z',
  },
];

// ---- Deterministic plan: every seed row carries an explicit id so repeated
// runs are byte-identical (the wipe truncates with RESTART IDENTITY, and each
// insert overrides the gen_random_uuid() default). The 10 users are the exact
// original seed (one admin + balanced office/doctor/patient mix).

export const initialData: SeedData = {
  users: USERS.map((entry, index) => ({
    id: entry.id,
    email: `${entry.name.toLowerCase()}${index}@seed.local`,
    name: entry.name,
    password: bcrypt.hashSync(SEED_PASSWORD, 10),
    role: entry.role,
  })),
  profiles: PROFILES,
  patients: PATIENTS,
  doctors: DOCTORS,
  surgeryCatalog: SURGERY_CATALOG,
  surgeries: SURGERIES,
  surgeryDoctors: SURGERY_DOCTORS,
  paymentPlans: PAYMENT_PLAN_SPECS.map((spec) => ({
    ...spec,
    outstandingBalance: OUTSTANDING_BALANCES.get(spec.id) ?? '0.00',
  })),
  installments: buildInstallments(),
  payments: PAYMENTS,
  auditLogs: AUDIT_LOGS,
  messageTemplates: MESSAGE_TEMPLATES,
  whatsappDispatches: WHATSAPP_DISPATCHES,
  botConversations: BOT_CONVERSATIONS,
  botMessages: BOT_MESSAGES,
};
