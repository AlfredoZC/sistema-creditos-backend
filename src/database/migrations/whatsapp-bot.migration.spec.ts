import { DataSource } from 'typeorm';
import { normalizePhone } from 'src/whatsapp/phone-normalizer';
import {
  WHATSAPP_MIGRATION_TEST_DATABASE,
  createMigrationTestDataSource,
  ensureFreshMigrationTestDatabase,
} from '../../test-utils/migration-test-db';

jest.setTimeout(120000);

interface IdRow {
  id: string;
}

interface PhoneRow {
  phone: string;
}

interface BackupRow {
  patient_id: string;
  original_phone: string;
  rewritten_phone: string;
}

/**
 * Migrate the fresh throwaway DB only up to CoreModules (002): the patients
 * table then exists with its legacy phones, and 003 is still pending so the
 * migration spec can seed legacy data BEFORE the phone data pass runs.
 */
const WHATSAPP_MIGRATION_BASE_VERSION = 1786000000002;

const CANONICAL_PLUS_591_PATTERN = /^\+591\d{8}$/;

/**
 * Seeded legacy phones covering every branch of the 003 phone pass:
 * - '+59170000001' vs '59170000001': the spec collision pair (design §5.6) —
 *   the second collides with an already-canonical row, so BOTH are skipped.
 * - '70000002' and '+591 7000-0003': unique mobiles -> safe rewrite + backup row.
 * - '24000000' (landline) and '+541123456789' (foreign): no heuristic -> skipped.
 * - '+59170000004': already canonical and unique -> untouched (no rewrite, no skip).
 *
 * All original values are distinct, which patients.uq_patients_phone requires.
 */
const PHONE_SEEDS: string[] = [
  '+59170000001', // collision member A (already canonical)
  '59170000001', // collision member B (legacy national format)
  '70000002', // unique mobile -> rewrite
  '+591 7000-0003', // unique canonical with separators -> rewrite
  '24000000', // landline -> no_heuristic skip
  '+541123456789', // foreign -> no_heuristic skip
  '+59170000004', // already canonical, unique -> untouched
];

/**
 * Predicted pass outcome per seed, computed with the RUNTIME normalizer
 * (src/whatsapp/phone-normalizer.ts) BEFORE 003 runs. Finding 4: the
 * migration's private D3 copy must mirror these rules exactly, so the
 * skipped/rewritten sets must match these predictions line by line.
 */
interface PassPrediction {
  expectedPhone: string;
  expectedBackup: boolean;
  reason: 'rewrite' | 'collision' | 'no_heuristic' | 'untouched';
}

function predictPassOutcome(seeds: string[]): PassPrediction[] {
  const byNormalized = new Map<string, string[]>();
  for (const seed of seeds) {
    const normalized = normalizePhone(seed);
    byNormalized.set(normalized, [
      ...(byNormalized.get(normalized) ?? []),
      seed,
    ]);
  }
  return seeds.map((seed) => {
    const normalized = normalizePhone(seed);
    const collides = (byNormalized.get(normalized) ?? []).length > 1;
    const canonical = CANONICAL_PLUS_591_PATTERN.test(normalized);
    if (collides) {
      return {
        expectedPhone: seed,
        expectedBackup: false,
        reason: 'collision' as const,
      };
    }
    if (!canonical) {
      return {
        expectedPhone: seed,
        expectedBackup: false,
        reason: 'no_heuristic' as const,
      };
    }
    if (normalized !== seed) {
      return {
        expectedPhone: normalized,
        expectedBackup: true,
        reason: 'rewrite' as const,
      };
    }
    return {
      expectedPhone: seed,
      expectedBackup: false,
      reason: 'untouched' as const,
    };
  });
}

const EXPECTED_TABLE_COLUMNS: Record<string, string[]> = {
  message_templates: [
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
    'created_at',
    'updated_at',
  ],
  whatsapp_dispatches: [
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
    'created_at',
    'updated_at',
    'sent_at',
  ],
  bot_conversations: [
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
  bot_messages: [
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
};

const EXPECTED_ENUM_VALUES: Record<string, string[]> = {
  dispatch_status: ['queued', 'sent', 'delivered', 'read', 'failed'],
  bot_direction: ['inbound', 'outbound'],
  bot_conversation_state: ['unidentified', 'awaiting_document', 'identified'],
  template_category: ['utility', 'marketing', 'authentication'],
  template_status: ['draft', 'submitted', 'approved', 'rejected', 'paused'],
};

const EXPECTED_INDEXES: Record<string, string[]> = {
  whatsapp_dispatches: [
    'idx_whatsapp_dispatches_status',
    'idx_whatsapp_dispatches_patient_id',
    'idx_whatsapp_dispatches_created_at',
  ],
  bot_conversations: ['idx_bot_conversations_patient_id'],
  bot_messages: ['idx_bot_messages_conversation_id'],
};

describe('whatsapp bot migration 003 contract (design sections 4 and 5)', () => {
  let dataSource: DataSource;
  let predictions: PassPrediction[];
  let seedIds: string[];
  let patientId: string;
  let templateId: string;
  let fixtureConversationId: string;

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

  beforeAll(async () => {
    // Fresh DB migrated only to 002 (Init + Auth + CoreModules): patients and
    // its legacy phone column exist, 003 is still pending.
    await ensureFreshMigrationTestDatabase(WHATSAPP_MIGRATION_TEST_DATABASE, {
      upToVersion: WHATSAPP_MIGRATION_BASE_VERSION,
    });

    dataSource = createMigrationTestDataSource(
      WHATSAPP_MIGRATION_TEST_DATABASE,
    );
    await dataSource.initialize();

    // Predict the phone pass with the runtime normalizer BEFORE 003 runs.
    predictions = predictPassOutcome(PHONE_SEEDS);

    // Seed legacy phones (distinct identity_document + phone per row).
    seedIds = [];
    for (const seed of PHONE_SEEDS) {
      const rows: IdRow[] = await dataSource.query(
        `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
         VALUES ($1, 'Paciente', 'Prueba', $2) RETURNING id`,
        [`doc-${seed}`, seed],
      );
      seedIds.push(rows[0].id);
    }
    patientId = seedIds[2]; // the '70000002' patient, used as dispatch FK

    // Apply the pending 003 on top of the seeded legacy data, then insert the
    // 003-era fixtures (message_templates / bot_conversations) it creates.
    await dataSource.runMigrations();

    const templates: IdRow[] = await dataSource.query(
      `INSERT INTO message_templates (name, category, body_template)
       VALUES ('plantilla_recordatorio', 'utility', 'Hola {{1}}') RETURNING id`,
    );
    templateId = templates[0].id;

    const conversations: IdRow[] = await dataSource.query(
      `INSERT INTO bot_conversations (wa_id) VALUES ('59199999999') RETURNING id`,
    );
    fixtureConversationId = conversations[0].id;
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('applies exactly Init/001/002 then 003 and 004 on the throwaway database', async () => {
    const applied: { count: number }[] = await dataSource.query(
      `SELECT count(*)::int AS count FROM migrations`,
    );
    expect(applied[0].count).toBe(6);
  });

  it('creates the four business tables with their design columns', async () => {
    for (const [tableName, expectedColumns] of Object.entries(
      EXPECTED_TABLE_COLUMNS,
    )) {
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

  it('creates the five enum types with design-ordered values', async () => {
    for (const [typeName, expectedValues] of Object.entries(
      EXPECTED_ENUM_VALUES,
    )) {
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

  it('creates the designed indexes on the three hot lookup paths', async () => {
    for (const [tableName, expectedIndexes] of Object.entries(
      EXPECTED_INDEXES,
    )) {
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
  });

  it('enforces the CHECK constraints at the DB level', async () => {
    // send_attempts > 3 (design §5.2) -> 23514
    await expectPgError(
      dataSource.query(
        `INSERT INTO whatsapp_dispatches (patient_id, template_id, phone, send_attempts)
         VALUES ($1, $2, '+59170000002', 4)`,
        [patientId, templateId],
      ),
      '23514',
    );

    // state <-> patient_id invariant (design §5.3): identified requires a
    // patient, any other state forbids one.
    await expectPgError(
      dataSource.query(
        `INSERT INTO bot_conversations (wa_id, state) VALUES ('w-state-a', 'identified')`,
      ),
      '23514',
    );
    await expectPgError(
      dataSource.query(
        `INSERT INTO bot_conversations (wa_id, state, patient_id)
         VALUES ('w-state-b', 'unidentified', $1)`,
        [patientId],
      ),
      '23514',
    );

    // bot_messages type validity and the template/template_id pair (design §5.4)
    await expectPgError(
      dataSource.query(
        `INSERT INTO bot_messages (conversation_id, direction, body, type)
         VALUES ($1, 'outbound', 'x', 'invalid')`,
        [fixtureConversationId],
      ),
      '23514',
    );
    await expectPgError(
      dataSource.query(
        `INSERT INTO bot_messages (conversation_id, direction, body, type)
         VALUES ($1, 'outbound', 'x', 'template')`,
        [fixtureConversationId],
      ),
      '23514',
    );

    // intent must be null or one of saldo/cuotas/proxima
    await expectPgError(
      dataSource.query(
        `INSERT INTO bot_messages (conversation_id, direction, body, type, intent)
         VALUES ($1, 'inbound', 'x', 'text', 'nonsense')`,
        [fixtureConversationId],
      ),
      '23514',
    );

    // failed_attempts range (design §5.3)
    await expectPgError(
      dataSource.query(
        `INSERT INTO bot_conversations (wa_id, failed_attempts) VALUES ('w-fail-a', 4)`,
      ),
      '23514',
    );
  });

  it('enforces the UNIQUE constraints at the DB level', async () => {
    // dedupe_key (design §5.2, D1) -> 23505
    await dataSource.query(
      `INSERT INTO whatsapp_dispatches (patient_id, template_id, phone, dedupe_key)
       VALUES ($1, $2, '+59170000002', 'dedupe-test-1')`,
      [patientId, templateId],
    );
    await expectPgError(
      dataSource.query(
        `INSERT INTO whatsapp_dispatches (patient_id, template_id, phone, dedupe_key)
         VALUES ($1, $2, '+59170000002', 'dedupe-test-1')`,
        [patientId, templateId],
      ),
      '23505',
    );

    // provider_message_id (design §5.2, AD6)
    await dataSource.query(
      `INSERT INTO whatsapp_dispatches (patient_id, template_id, phone, status, send_attempts, provider_message_id)
       VALUES ($1, $2, '+59170000002', 'sent', 1, 'wamid.test.dispatch.1')`,
      [patientId, templateId],
    );
    await expectPgError(
      dataSource.query(
        `INSERT INTO whatsapp_dispatches (patient_id, template_id, phone, status, send_attempts, provider_message_id)
         VALUES ($1, $2, '+59170000002', 'sent', 1, 'wamid.test.dispatch.1')`,
        [patientId, templateId],
      ),
      '23505',
    );

    // wa_id (design §5.3, Q7)
    await dataSource.query(
      `INSERT INTO bot_conversations (wa_id) VALUES ('wa-dupe-1')`,
    );
    await expectPgError(
      dataSource.query(
        `INSERT INTO bot_conversations (wa_id) VALUES ('wa-dupe-1')`,
      ),
      '23505',
    );

    // bot_messages.provider_message_id (design §5.4, AD6)
    await dataSource.query(
      `INSERT INTO bot_messages (conversation_id, direction, body, provider_message_id)
       VALUES ($1, 'inbound', 'hola', 'wamid.test.bot.1')`,
      [fixtureConversationId],
    );
    await expectPgError(
      dataSource.query(
        `INSERT INTO bot_messages (conversation_id, direction, body, provider_message_id)
         VALUES ($1, 'inbound', 'hola', 'wamid.test.bot.1')`,
        [fixtureConversationId],
      ),
      '23505',
    );
  });

  it(
    'phone pass rewrites safe rows with backup and leaves collisions, ' +
      'non-heuristic rows, and canonical rows exactly as the runtime normalizer predicts',
    async () => {
      // Every seeded patient must hold exactly the predicted phone value.
      for (let i = 0; i < PHONE_SEEDS.length; i += 1) {
        const rows: PhoneRow[] = await dataSource.query(
          `SELECT phone FROM patients WHERE id = $1`,
          [seedIds[i]],
        );
        expect(rows[0].phone).toBe(predictions[i].expectedPhone);
      }

      // The backup table holds exactly the predicted rewrites.
      const rewrites = predictions
        .map((prediction, index) => ({ prediction, index }))
        .filter(({ prediction }) => prediction.reason === 'rewrite');
      expect(rewrites.length).toBeGreaterThan(0);

      const backupRows: BackupRow[] = await dataSource.query(
        `SELECT patient_id, original_phone, rewritten_phone
           FROM phone_normalization_backup ORDER BY rewritten_phone`,
      );
      expect(backupRows).toEqual(
        rewrites.map(({ prediction, index }) => ({
          patient_id: seedIds[index],
          original_phone: PHONE_SEEDS[index],
          rewritten_phone: prediction.expectedPhone,
        })),
      );

      // Skipped and untouched patients must have NO backup row.
      for (let i = 0; i < PHONE_SEEDS.length; i += 1) {
        if (predictions[i].expectedBackup) {
          continue;
        }
        const rows: { count: number }[] = await dataSource.query(
          `SELECT count(*)::int AS count
             FROM phone_normalization_backup WHERE patient_id = $1`,
          [seedIds[i]],
        );
        expect(rows[0].count).toBe(0);
      }

      // The spec collision pair (+59170000001 / 59170000001, design §5.6) is
      // skipped as a pair: BOTH rows keep their original phone values.
      expect(predictions[0].reason).toBe('collision');
      expect(predictions[1].reason).toBe('collision');
      const first: PhoneRow[] = await dataSource.query(
        `SELECT phone FROM patients WHERE id = $1`,
        [seedIds[0]],
      );
      const second: PhoneRow[] = await dataSource.query(
        `SELECT phone FROM patients WHERE id = $1`,
        [seedIds[1]],
      );
      expect(first[0].phone).toBe('+59170000001');
      expect(second[0].phone).toBe('59170000001');
    },
  );

  it(
    'down() restores original phones, drops the backup table, the four ' +
      'business tables, and the five enum types',
    async () => {
      await dataSource.undoLastMigration(); // reverts 005 (InstallmentReminders)
      await dataSource.undoLastMigration(); // reverts 004 (DoctorDetails)
      await dataSource.undoLastMigration(); // reverts 003 (WhatsAppBot)

      // Originals restored for every seeded patient (rewritten and untouched).
      for (let i = 0; i < PHONE_SEEDS.length; i += 1) {
        const rows: PhoneRow[] = await dataSource.query(
          `SELECT phone FROM patients WHERE id = $1`,
          [seedIds[i]],
        );
        expect(rows[0].phone).toBe(PHONE_SEEDS[i]);
      }

      const tables: { count: number }[] = await dataSource.query(
        `SELECT count(*)::int AS count
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name IN
                ('message_templates', 'whatsapp_dispatches',
                 'bot_conversations', 'bot_messages',
                 'phone_normalization_backup')`,
      );
      expect(tables[0].count).toBe(0);

      const enumTypes: { count: number }[] = await dataSource.query(
        `SELECT count(*)::int AS count
           FROM pg_type t
           JOIN pg_enum e ON e.enumtypid = t.oid
          WHERE t.typname IN
                ('dispatch_status', 'bot_direction',
                 'bot_conversation_state', 'template_category',
                 'template_status')`,
      );
      expect(enumTypes[0].count).toBe(0);

      const applied: { count: number }[] = await dataSource.query(
        `SELECT count(*)::int AS count FROM migrations`,
      );
      expect(applied[0].count).toBe(3);
    },
  );
});
