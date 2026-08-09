import { DataSource } from 'typeorm';
import {
  CORE_MIGRATION_TEST_DATABASE,
  createMigrationTestDataSource,
  ensureFreshMigrationTestDatabase,
} from '../../test-utils/migration-test-db';

jest.setTimeout(120000);

interface IdRow {
  id: string;
}

interface FixtureIds {
  officeUserId: string;
  patientId: string;
  doctorId: string;
  surgeryId: string;
  secondSurgeryId: string;
  planId: string;
  installmentId: string;
  paymentMethodId: string;
}

const EXPECTED_TABLE_COLUMNS: Record<string, string[]> = {
  patients: [
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
  doctors: [
    'id',
    'user_id',
    'specialty',
    'professional_license',
    'first_name',
    'paternal_last_name',
    'maternal_last_name',
    'phone',
  ],
  surgery_catalog: ['id', 'name', 'description', 'base_cost'],
  surgeries: [
    'id',
    'patient_id',
    'surgery_catalog_id',
    'scheduled_date',
    'total_cost',
    'status',
    'notes',
  ],
  surgery_doctors: ['id', 'surgery_id', 'doctor_id', 'role'],
  payment_plans: [
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
  installments: [
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
  payment_methods: ['id', 'name', 'is_enabled', 'description'],
  payments: [
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
    'receipt_url',
    'status',
  ],
  audit_logs: [
    'id',
    'user_id',
    'action',
    'table_name',
    'record_id',
    'previous_data',
    'new_data',
    'created_at',
  ],
};

const EXPECTED_ENUM_VALUES: Record<string, string[]> = {
  surgery_status: ['scheduled', 'performed', 'cancelled'],
  surgery_doctor_role: ['principal', 'assistant', 'anesthesiologist'],
  payment_plan_type: ['upfront', 'credit'],
  payment_plan_status: ['active', 'completed', 'delinquent', 'cancelled'],
  installment_status: ['pending', 'partial', 'paid', 'overdue', 'cancelled'],
  payment_type: ['down_payment', 'installment_payment', 'principal_amortization'],
  payment_status: ['pending_confirmation', 'confirmed', 'rejected'],
  amortization_mode: ['reduce_installment', 'reduce_term'],
};

const EXPECTED_INDEXES: Record<string, string[]> = {
  doctors: ['uq_doctors_phone'],
  surgeries: ['idx_surgeries_patient_id'],
  surgery_doctors: [
    'idx_surgery_doctors_surgery_id',
    'idx_surgery_doctors_doctor_id',
    'uq_one_principal_per_surgery',
  ],
  installments: [
    'idx_installments_payment_plan_id',
    'idx_installments_due_date_status',
  ],
  payments: [
    'idx_payments_payment_plan_id',
    'idx_payments_installment_id',
    'idx_payments_recorded_by_user_id',
  ],
  audit_logs: ['idx_audit_logs_user_id', 'idx_audit_logs_created_at'],
};

describe('core modules migration (design sections 5 and 10)', () => {
  let dataSource: DataSource;

  async function expectPgError(
    promise: Promise<unknown>,
    code: string,
  ): Promise<void> {
    try {
      await promise;
    } catch (error) {
      expect((error as { code?: string }).code).toBe(code);
      return;
    }
    throw new Error(`expected a PostgreSQL error with code ${code}`);
  }

  async function insertDoctor(license: string): Promise<string> {
    const user: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role) VALUES ($1, 'hashed', 'Doctor', 'doctor') RETURNING id`,
      [`doctor-${license}@example.com`],
    );
    // AD10: uq_doctors_phone rejects two DEFAULT '' rows, so the phone is
    // derived from the license (LIC-001 -> '+59171001', LIC-002 -> '+59171002').
    const doctor: IdRow[] = await dataSource.query(
      `INSERT INTO doctors (user_id, specialty, professional_license, phone) VALUES ($1, 'Traumatologia', $2, $3) RETURNING id`,
      [user[0].id, license, `+59171${license.replace(/\D/g, '')}`],
    );
    return doctor[0].id;
  }

  async function insertSurgery(
    patientId: string,
    catalogId: string,
  ): Promise<string> {
    const surgery: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, '2026-09-15', 100.00) RETURNING id`,
      [patientId, catalogId],
    );
    return surgery[0].id;
  }

  async function insertFixtureChain(): Promise<FixtureIds> {
    const office: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role) VALUES ('office@example.com', 'hashed', 'Office', 'office') RETURNING id`,
    );
    const patient: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ('12345678', 'Ana', 'Perez', '51999999999') RETURNING id`,
    );
    const doctorId = await insertDoctor('LIC-001');
    const catalog: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, description, base_cost)
       VALUES ('Cirugia de rodilla', 'Reemplazo parcial', 100.00) RETURNING id`,
    );
    const surgeryId = await insertSurgery(patient[0].id, catalog[0].id);
    const secondSurgeryId = await insertSurgery(patient[0].id, catalog[0].id);
    const plan: IdRow[] = await dataSource.query(
      `INSERT INTO payment_plans (surgery_id, type, down_payment, financed_amount, monthly_interest_rate, installment_count, start_date, outstanding_balance)
       VALUES ($1, 'credit', 0.00, 100.00, 2.00, 3, '2026-09-15', 100.00) RETURNING id`,
      [surgeryId],
    );
    const installment: IdRow[] = await dataSource.query(
      `INSERT INTO installments (payment_plan_id, installment_number, principal_amount, interest_amount, total_amount, paid_amount, due_date)
       VALUES ($1, 1, 32.68, 0.67, 33.35, 0.00, '2026-10-15') RETURNING id`,
      [plan[0].id],
    );
    const method: IdRow[] = await dataSource.query(
      `SELECT id FROM payment_methods WHERE name = 'cash'`,
    );
    return {
      officeUserId: office[0].id,
      patientId: patient[0].id,
      doctorId,
      surgeryId,
      secondSurgeryId,
      planId: plan[0].id,
      installmentId: installment[0].id,
      paymentMethodId: method[0].id,
    };
  }

  beforeAll(async () => {
    await ensureFreshMigrationTestDatabase(CORE_MIGRATION_TEST_DATABASE);
    dataSource = createMigrationTestDataSource(CORE_MIGRATION_TEST_DATABASE);
    await dataSource.initialize();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    // Clean slate between fixture tests without touching the seeded
    // payment_methods rows (same FK-safe wipe order as the design's seed).
    await dataSource.query(
      `TRUNCATE TABLE "audit_logs", "payments", "installments", "payment_plans", "surgery_doctors", "surgeries", "surgery_catalog", "doctors", "patients", "users", "profiles" RESTART IDENTITY CASCADE`,
    );
  });

  it('migrates a fresh database cleanly from Init', async () => {
    // 5 migrations: Init, 001-AuthSingleRole, 002-CoreModules, 003-WhatsAppBot,
    // 004-DoctorDetails.
    const applied: { count: number }[] = await dataSource.query(
      `SELECT count(*)::int AS count FROM migrations`,
    );
    expect(applied[0].count).toBe(5);

    for (const tableName of Object.keys(EXPECTED_TABLE_COLUMNS)) {
      if (tableName === 'payment_methods') {
        // payment_methods carries the seed data; asserted separately below.
        continue;
      }
      const rows: { count: number }[] = await dataSource.query(
        `SELECT count(*)::int AS count FROM "${tableName}"`,
      );
      expect(rows[0].count).toBe(0);
    }
  });

  it('creates all ten tables with their translated columns', async () => {
    for (const [tableName, expectedColumns] of Object.entries(EXPECTED_TABLE_COLUMNS)) {
      const rows: { column_name: string }[] = await dataSource.query(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`,
        [tableName],
      );
      expect(rows.map((row) => row.column_name)).toEqual(expectedColumns);
    }
  });

  it('creates the eight enum types with design-ordered values', async () => {
    for (const [typeName, expectedValues] of Object.entries(EXPECTED_ENUM_VALUES)) {
      const rows: { enumlabel: string }[] = await dataSource.query(
        `SELECT e.enumlabel
           FROM pg_type t
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname = $1
          ORDER BY e.enumsortorder`,
        [typeName],
      );
      expect(rows.map((row) => row.enumlabel)).toEqual(expectedValues);
    }
  });

  it('seeds the four payment methods', async () => {
    const rows: { name: string; is_enabled: boolean }[] = await dataSource.query(
      `SELECT name, is_enabled FROM payment_methods ORDER BY name`,
    );
    expect(rows).toEqual([
      { name: 'bank_transfer', is_enabled: true },
      { name: 'card', is_enabled: true },
      { name: 'cash', is_enabled: true },
      { name: 'qr', is_enabled: true },
    ]);
  });

  it('creates the translated indexes and the one-principal partial unique index', async () => {
    for (const [tableName, expectedIndexes] of Object.entries(EXPECTED_INDEXES)) {
      const rows: { indexname: string }[] = await dataSource.query(
        `SELECT indexname
           FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = $1`,
        [tableName],
      );
      expect(rows.map((row) => row.indexname)).toEqual(
        expect.arrayContaining(expectedIndexes),
      );
    }

    const definitions: { indexdef: string }[] = await dataSource.query(
      `SELECT indexdef
         FROM pg_indexes
        WHERE schemaname = 'public' AND indexname = 'uq_one_principal_per_surgery'`,
    );
    expect(definitions[0].indexdef).toContain("role = 'principal'");
  });

  it('rejects negative and zero money values through CHECK constraints', async () => {
    const ids = await insertFixtureChain();

    await expectPgError(
      dataSource.query(
        `INSERT INTO surgery_catalog (name, base_cost) VALUES ('Costo negativo', -1.00)`,
      ),
      '23514',
    );

    await expectPgError(
      dataSource.query(
        `INSERT INTO payment_plans (surgery_id, type, financed_amount, installment_count, start_date, outstanding_balance)
         VALUES ($1, 'upfront', 100.00, 0, '2026-09-15', 100.00)`,
        [ids.secondSurgeryId],
      ),
      '23514',
    );

    await expectPgError(
      dataSource.query(
        `INSERT INTO installments (payment_plan_id, installment_number, principal_amount, interest_amount, total_amount, paid_amount, due_date)
         VALUES ($1, 9, 10.00, 0.00, 10.00, 11.00, '2026-11-15')`,
        [ids.planId],
      ),
      '23514',
    );

    await expectPgError(
      dataSource.query(
        `INSERT INTO payments (payment_plan_id, recorded_by_user_id, payment_method_id, amount, type)
         VALUES ($1, $2, $3, 0.00, 'down_payment')`,
        [ids.planId, ids.officeUserId, ids.paymentMethodId],
      ),
      '23514',
    );
  });

  it('enforces the payment type integrity rules at the DB level', async () => {
    const ids = await insertFixtureChain();

    await expectPgError(
      dataSource.query(
        `INSERT INTO payments (payment_plan_id, installment_id, recorded_by_user_id, payment_method_id, amount, type, amortization_mode)
         VALUES ($1, $2, $3, $4, 50.00, 'principal_amortization', 'reduce_installment')`,
        [ids.planId, ids.installmentId, ids.officeUserId, ids.paymentMethodId],
      ),
      '23514',
    );

    await expectPgError(
      dataSource.query(
        `INSERT INTO payments (payment_plan_id, recorded_by_user_id, payment_method_id, amount, type)
         VALUES ($1, $2, $3, 50.00, 'installment_payment')`,
        [ids.planId, ids.officeUserId, ids.paymentMethodId],
      ),
      '23514',
    );

    await expectPgError(
      dataSource.query(
        `INSERT INTO payments (payment_plan_id, installment_id, recorded_by_user_id, payment_method_id, amount, type, amortization_mode)
         VALUES ($1, $2, $3, $4, 50.00, 'installment_payment', 'reduce_installment')`,
        [ids.planId, ids.installmentId, ids.officeUserId, ids.paymentMethodId],
      ),
      '23514',
    );

    // A down_payment without installment or amortization mode is valid.
    await dataSource.query(
      `INSERT INTO payments (payment_plan_id, recorded_by_user_id, payment_method_id, amount, type)
       VALUES ($1, $2, $3, 50.00, 'down_payment')`,
      [ids.planId, ids.officeUserId, ids.paymentMethodId],
    );
  });

  it('enforces exactly one principal per surgery via the partial unique index', async () => {
    const ids = await insertFixtureChain();
    const secondDoctorId = await insertDoctor('LIC-002');

    await dataSource.query(
      `INSERT INTO surgery_doctors (surgery_id, doctor_id) VALUES ($1, $2)`,
      [ids.surgeryId, ids.doctorId],
    );

    // A second principal for the same surgery is rejected.
    await expectPgError(
      dataSource.query(
        `INSERT INTO surgery_doctors (surgery_id, doctor_id) VALUES ($1, $2)`,
        [ids.surgeryId, secondDoctorId],
      ),
      '23505',
    );

    // The same doctor cannot be assigned twice to one surgery.
    await expectPgError(
      dataSource.query(
        `INSERT INTO surgery_doctors (surgery_id, doctor_id, role) VALUES ($1, $2, 'assistant')`,
        [ids.surgeryId, ids.doctorId],
      ),
      '23505',
    );

    // A non-principal role for the second doctor is allowed.
    await dataSource.query(
      `INSERT INTO surgery_doctors (surgery_id, doctor_id, role) VALUES ($1, $2, 'assistant')`,
      [ids.surgeryId, secondDoctorId],
    );

    // Another surgery may have its own principal.
    await dataSource.query(
      `INSERT INTO surgery_doctors (surgery_id, doctor_id) VALUES ($1, $2)`,
      [ids.secondSurgeryId, secondDoctorId],
    );
  });
});
