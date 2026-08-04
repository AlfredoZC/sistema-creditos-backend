import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * WhatsApp Bot migration: 5 enum types, the one-time phone-backup table, the
 * 4 business tables (message_templates, whatsapp_dispatches,
 * bot_conversations, bot_messages), their UNIQUEs/FKs/CHECKs/indexes, a
 * conservative report-only phone data pass, and the matching down() that
 * restores patients.phone from the backup before dropping everything.
 *
 * Phone data pass (design D3): the normalizer below is a DELIBERATELY
 * duplicated, self-contained copy of src/whatsapp/phone-normalizer.ts so this
 * migration stays a byte-stable snapshot (importing the runtime normalizer
 * would let a later normalizer change silently alter historical migration
 * semantics). KEEP BOTH IN SYNC — the pass must mirror the runtime rules
 * exactly so collision-skipped rows are predictable (finding 4).
 *
 * Pass semantics: rows that normalize to a canonical +591XXXXXXXX value are
 * rewritten (backed up first); every collision group (two or more rows
 * normalizing to the same value) is fully skipped and logged; anything the
 * heuristic does not apply to (landlines, foreign, ambiguous) is skipped and
 * logged. The console report lists EVERY rewritten and EVERY skipped row, plus
 * a summary count. down() restores the original values and drops the backup.
 */
export class WhatsAppBot1786000000003 implements MigrationInterface {
  name = 'WhatsAppBot1786000000003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- 5 enum types (design §4) ----------------------------------------
    await queryRunner.query(
      `CREATE TYPE "dispatch_status" AS ENUM ('queued', 'sent', 'delivered', 'read', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "bot_direction" AS ENUM ('inbound', 'outbound')`,
    );
    await queryRunner.query(
      `CREATE TYPE "bot_conversation_state" AS ENUM ('unidentified', 'awaiting_document', 'identified')`,
    );
    await queryRunner.query(
      `CREATE TYPE "template_category" AS ENUM ('utility', 'marketing', 'authentication')`,
    );
    await queryRunner.query(
      `CREATE TYPE "template_status" AS ENUM ('draft', 'submitted', 'approved', 'rejected', 'paused')`,
    );

    // ---- one-time phone-backup table (design §5.5, D3) -------------------
    await queryRunner.query(
      `CREATE TABLE "phone_normalization_backup" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "patient_id" uuid NOT NULL,
        "original_phone" character varying(50) NOT NULL,
        "rewritten_phone" character varying(50) NOT NULL,
        CONSTRAINT "pk_phone_normalization_backup" PRIMARY KEY ("id"),
        CONSTRAINT "uq_phone_normalization_backup_patient" UNIQUE ("patient_id"),
        CONSTRAINT "fk_phone_normalization_backup_patient_id" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )`,
    );

    // ---- 4 business tables (design §5.1–5.4) -----------------------------
    await queryRunner.query(
      `CREATE TABLE "message_templates" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(100) NOT NULL,
        "category" "template_category" NOT NULL,
        "language" character varying(10) NOT NULL DEFAULT 'es',
        "body_template" text NOT NULL,
        "sample_variables" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "status" "template_status" NOT NULL DEFAULT 'draft',
        "provider_template_id" character varying(255),
        "provider_status" character varying(50),
        "is_active" boolean NOT NULL DEFAULT true,
        "created_by_user_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_message_templates" PRIMARY KEY ("id"),
        CONSTRAINT "uq_message_templates_name_language" UNIQUE ("name", "language"),
        CONSTRAINT "fk_message_templates_created_by_user_id" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "chk_message_templates_body_non_empty" CHECK ("body_template" <> '')
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "whatsapp_dispatches" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "patient_id" uuid NOT NULL,
        "template_id" uuid NOT NULL,
        "status" "dispatch_status" NOT NULL DEFAULT 'queued',
        "send_attempts" smallint NOT NULL DEFAULT 0,
        "provider_message_id" character varying(255),
        "provider_error" text,
        "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "phone" character varying(50) NOT NULL,
        "dedupe_key" text,
        "created_by_user_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "sent_at" timestamptz,
        CONSTRAINT "pk_whatsapp_dispatches" PRIMARY KEY ("id"),
        CONSTRAINT "uq_whatsapp_dispatches_provider_message_id" UNIQUE ("provider_message_id"),
        CONSTRAINT "uq_whatsapp_dispatches_dedupe_key" UNIQUE ("dedupe_key"),
        CONSTRAINT "fk_whatsapp_dispatches_patient_id" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "fk_whatsapp_dispatches_template_id" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "fk_whatsapp_dispatches_created_by_user_id" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "chk_whatsapp_dispatches_send_attempts_range" CHECK ("send_attempts" >= 0 AND "send_attempts" <= 3),
        CONSTRAINT "chk_whatsapp_dispatches_queued_has_no_wamid" CHECK ("status" <> 'queued' OR "provider_message_id" IS NULL)
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "bot_conversations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "wa_id" character varying(50) NOT NULL,
        "patient_id" uuid,
        "state" "bot_conversation_state" NOT NULL DEFAULT 'unidentified',
        "failed_attempts" smallint NOT NULL DEFAULT 0,
        "lockout_until" timestamptz,
        "last_activity_at" timestamptz NOT NULL DEFAULT now(),
        "started_at" timestamptz NOT NULL DEFAULT now(),
        "ended_at" timestamptz,
        CONSTRAINT "pk_bot_conversations" PRIMARY KEY ("id"),
        CONSTRAINT "uq_bot_conversations_wa_id" UNIQUE ("wa_id"),
        CONSTRAINT "fk_bot_conversations_patient_id" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "chk_bot_conversations_failed_attempts_range" CHECK ("failed_attempts" >= 0 AND "failed_attempts" <= 3),
        CONSTRAINT "chk_bot_conversations_lockout_requires_failures" CHECK ("lockout_until" IS NULL OR "failed_attempts" >= 3),
        CONSTRAINT "chk_bot_conversations_state_matches_patient" CHECK (("state" = 'identified' AND "patient_id" IS NOT NULL) OR ("state" <> 'identified' AND "patient_id" IS NULL))
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "bot_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "conversation_id" uuid NOT NULL,
        "direction" "bot_direction" NOT NULL,
        "body" text NOT NULL,
        "provider_message_id" character varying(255),
        "type" character varying(10) NOT NULL DEFAULT 'text',
        "template_id" uuid,
        "intent" character varying(20),
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_bot_messages" PRIMARY KEY ("id"),
        CONSTRAINT "uq_bot_messages_provider_message_id" UNIQUE ("provider_message_id"),
        CONSTRAINT "fk_bot_messages_conversation_id" FOREIGN KEY ("conversation_id") REFERENCES "bot_conversations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "fk_bot_messages_template_id" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "chk_bot_messages_type_valid" CHECK ("type" IN ('text', 'template')),
        CONSTRAINT "chk_bot_messages_template_requires_template_type" CHECK ("type" <> 'template' OR "template_id" IS NOT NULL),
        CONSTRAINT "chk_bot_messages_intent_valid" CHECK ("intent" IS NULL OR "intent" IN ('saldo', 'cuotas', 'proxima'))
      )`,
    );

    // ---- indexes (design §5.2–5.4) ---------------------------------------
    await queryRunner.query(
      `CREATE INDEX "idx_whatsapp_dispatches_status" ON "whatsapp_dispatches" ("status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_whatsapp_dispatches_patient_id" ON "whatsapp_dispatches" ("patient_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_whatsapp_dispatches_created_at" ON "whatsapp_dispatches" ("created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_bot_conversations_patient_id" ON "bot_conversations" ("patient_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_bot_messages_conversation_id" ON "bot_messages" ("conversation_id")`,
    );

    // ---- conservative report-only phone data pass (design §5.6) ----------
    const patients = (await queryRunner.query(
      `SELECT "id", "phone" FROM "patients" ORDER BY "id"`,
    )) as Array<{ id: string; phone: string }>;

    // Group every row by its normalized value: any group with more than one
    // member is a collision (e.g. '+59170000001' versus '59170000001') and ALL
    // its members are skipped — never merged, never guessed (design §5.6 step 3).
    const groups = new Map<string, string[]>();
    for (const patient of patients) {
      const normalized = normalizeMigrationPhone(patient.phone);
      const bucket = groups.get(normalized) ?? [];
      bucket.push(patient.id);
      groups.set(normalized, bucket);
    }

    let rewritten = 0;
    let collisionSkips = 0;
    let heuristicSkips = 0;
    for (const patient of patients) {
      const { id, phone } = patient;
      const normalized = normalizeMigrationPhone(phone);
      const collision = (groups.get(normalized) ?? []).length > 1;
      const canonical = CANONICAL_PLUS_591_PATTERN.test(normalized);

      if (collision) {
        console.log(`SKIP<collision> ${id}: ${phone} -> ${normalized}`);
        collisionSkips += 1;
      } else if (!canonical) {
        // Heuristic not applicable (landline, foreign, ambiguous) — kept as
        // provided, never guessed.
        console.log(`SKIP<no_heuristic> ${id}: ${phone}`);
        heuristicSkips += 1;
      } else if (normalized !== phone) {
        await queryRunner.query(
          `UPDATE "patients" SET "phone" = $1 WHERE "id" = $2`,
          [normalized, id],
        );
        await queryRunner.query(
          `INSERT INTO "phone_normalization_backup" ("patient_id", "original_phone", "rewritten_phone") VALUES ($1, $2, $3)`,
          [id, phone, normalized],
        );
        console.log(`REWRITE ${id}: ${phone} -> ${normalized}`);
        rewritten += 1;
      }
      // Else: already canonical, no action needed — not rewritten, not skipped.
    }

    console.log(
      `Phone normalization pass complete: ${patients.length} patients, REWRITE=${rewritten}, SKIP=${collisionSkips + heuristicSkips} (collision=${collisionSkips}, no_heuristic=${heuristicSkips})`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the original phone values for every rewritten patient, then
    // drop the backup and the schema in reverse dependency order (design §5.6).
    await queryRunner.query(
      `UPDATE "patients" p SET "phone" = b."original_phone" FROM "phone_normalization_backup" b WHERE p."id" = b."patient_id"`,
    );
    await queryRunner.query(`DROP TABLE "phone_normalization_backup"`);
    await queryRunner.query(`DROP TABLE "bot_messages"`);
    await queryRunner.query(`DROP TABLE "whatsapp_dispatches"`);
    await queryRunner.query(`DROP TABLE "bot_conversations"`);
    await queryRunner.query(`DROP TABLE "message_templates"`);
    await queryRunner.query(`DROP TYPE "dispatch_status"`);
    await queryRunner.query(`DROP TYPE "bot_direction"`);
    await queryRunner.query(`DROP TYPE "bot_conversation_state"`);
    await queryRunner.query(`DROP TYPE "template_category"`);
    await queryRunner.query(`DROP TYPE "template_status"`);
  }
}

// ---- D3 duplication point: self-contained normalizer copy ------------------
// Keep this EXACTLY in sync with src/whatsapp/phone-normalizer.ts (design §6).
// It must stay PRIVATE (not exported): TypeORM's migration loader instantiates
// every export of a migration file, and a function export would crash
// migration:run (ConnectionMetadataBuilder -> buildMigrations). The finding-4
// mirror contract (rewrites/skips match runtime-normalizer predictions) is
// verified end-to-end by the migration harness.

const BOLIVIA_COUNTRY_CODE = '591';
const MOBILE_PREFIX_PATTERN = /^[67]\d{7}$/;
const NATIONAL_591_PATTERN = /^591\d{8}$/;
const CANONICAL_PLUS_591_PATTERN = /^\+591\d{8}$/;

function stripSeparators(input: string): string {
  const hadLeadingPlus = input.startsWith('+');
  const digits = input.replace(/[^\d]/g, '');
  return hadLeadingPlus ? `+${digits}` : digits;
}

/**
 * Deterministic canonicalization: strip separators (single leading `+`
 * preserved), then apply the +591-mobile heuristic:
 * - 8 digits starting with 6 or 7 -> `+591` + digits
 * - 11 chars `591` + 8 digits -> `+` + digits
 * - 12 chars starting `+591` (8 following digits) -> unchanged
 * - anything else -> stripped form as-is (never guessed)
 */
function normalizeMigrationPhone(input: string): string {
  const stripped = stripSeparators(input);
  const digits = stripped.startsWith('+') ? stripped.slice(1) : stripped;

  if (MOBILE_PREFIX_PATTERN.test(digits)) {
    return `+${BOLIVIA_COUNTRY_CODE}${digits}`;
  }
  if (NATIONAL_591_PATTERN.test(digits)) {
    return `+${digits}`;
  }
  if (CANONICAL_PLUS_591_PATTERN.test(stripped)) {
    return stripped;
  }
  return stripped;
}
