import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Core business modules: the 8 remaining enum types (user_role lives in 001)
 * and the 10 translated tables (patients, doctors, surgery_catalog,
 * surgeries, surgery_doctors, payment_plans, installments, payment_methods,
 * payments, audit_logs) with CHECKs, UNIQUEs, FK indexes and the
 * one-principal-per-surgery partial unique index, plus the payment-methods
 * seed. Down drops everything in reverse dependency order.
 */
export class CoreModules1786000000002 implements MigrationInterface {
  name = 'CoreModules1786000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "surgery_status" AS ENUM ('scheduled', 'performed', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "surgery_doctor_role" AS ENUM ('principal', 'assistant', 'anesthesiologist')`,
    );
    await queryRunner.query(
      `CREATE TYPE "payment_plan_type" AS ENUM ('upfront', 'credit')`,
    );
    await queryRunner.query(
      `CREATE TYPE "payment_plan_status" AS ENUM ('active', 'completed', 'delinquent', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "installment_status" AS ENUM ('pending', 'partial', 'paid', 'overdue', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "payment_type" AS ENUM ('down_payment', 'installment_payment', 'principal_amortization')`,
    );
    await queryRunner.query(
      `CREATE TYPE "payment_status" AS ENUM ('pending_confirmation', 'confirmed', 'rejected')`,
    );
    await queryRunner.query(
      `CREATE TYPE "amortization_mode" AS ENUM ('reduce_installment', 'reduce_term')`,
    );

    await queryRunner.query(
      `CREATE TABLE "patients" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid,
        "identity_document" character varying(20) NOT NULL,
        "first_name" character varying(50) NOT NULL,
        "paternal_last_name" character varying(50) NOT NULL,
        "maternal_last_name" character varying(50),
        "birth_date" date,
        "address" character varying(100),
        "phone" character varying(50) NOT NULL,
        CONSTRAINT "pk_patients" PRIMARY KEY ("id"),
        CONSTRAINT "uq_patients_user_id" UNIQUE ("user_id"),
        CONSTRAINT "uq_patients_identity_document" UNIQUE ("identity_document"),
        CONSTRAINT "uq_patients_phone" UNIQUE ("phone"),
        CONSTRAINT "fk_patients_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "doctors" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "specialty" text NOT NULL,
        "professional_license" text NOT NULL,
        CONSTRAINT "pk_doctors" PRIMARY KEY ("id"),
        CONSTRAINT "uq_doctors_user_id" UNIQUE ("user_id"),
        CONSTRAINT "uq_doctors_professional_license" UNIQUE ("professional_license"),
        CONSTRAINT "fk_doctors_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "surgery_catalog" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(50) NOT NULL,
        "description" text,
        "base_cost" numeric(10,2) NOT NULL,
        CONSTRAINT "pk_surgery_catalog" PRIMARY KEY ("id"),
        CONSTRAINT "chk_surgery_catalog_base_cost_non_negative" CHECK ("base_cost" >= 0)
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "surgeries" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "patient_id" uuid NOT NULL,
        "surgery_catalog_id" uuid NOT NULL,
        "scheduled_date" date NOT NULL,
        "total_cost" numeric(10,2) NOT NULL,
        "status" "surgery_status" NOT NULL DEFAULT 'scheduled',
        "notes" text,
        CONSTRAINT "pk_surgeries" PRIMARY KEY ("id"),
        CONSTRAINT "fk_surgeries_patient_id" FOREIGN KEY ("patient_id") REFERENCES "patients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "fk_surgeries_surgery_catalog_id" FOREIGN KEY ("surgery_catalog_id") REFERENCES "surgery_catalog"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "chk_surgeries_total_cost_non_negative" CHECK ("total_cost" >= 0)
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "surgery_doctors" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "surgery_id" uuid NOT NULL,
        "doctor_id" uuid NOT NULL,
        "role" "surgery_doctor_role" NOT NULL DEFAULT 'principal',
        CONSTRAINT "pk_surgery_doctors" PRIMARY KEY ("id"),
        CONSTRAINT "uq_surgery_doctors_surgery_doctor" UNIQUE ("surgery_id", "doctor_id"),
        CONSTRAINT "fk_surgery_doctors_surgery_id" FOREIGN KEY ("surgery_id") REFERENCES "surgeries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "fk_surgery_doctors_doctor_id" FOREIGN KEY ("doctor_id") REFERENCES "doctors"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "payment_plans" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "surgery_id" uuid NOT NULL,
        "type" "payment_plan_type" NOT NULL,
        "down_payment" numeric(10,2) NOT NULL DEFAULT '0.00',
        "financed_amount" numeric(10,2) NOT NULL,
        "monthly_interest_rate" numeric(10,2) NOT NULL DEFAULT '2.00',
        "installment_count" integer NOT NULL,
        "start_date" date NOT NULL,
        "outstanding_balance" numeric(10,2) NOT NULL,
        "status" "payment_plan_status" NOT NULL DEFAULT 'active',
        CONSTRAINT "pk_payment_plans" PRIMARY KEY ("id"),
        CONSTRAINT "uq_payment_plans_surgery_id" UNIQUE ("surgery_id"),
        CONSTRAINT "fk_payment_plans_surgery_id" FOREIGN KEY ("surgery_id") REFERENCES "surgeries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "chk_payment_plans_installment_count_positive" CHECK ("installment_count" > 0),
        CONSTRAINT "chk_payment_plans_amounts_non_negative" CHECK ("financed_amount" >= 0 AND "outstanding_balance" >= 0 AND "down_payment" >= 0)
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "installments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "payment_plan_id" uuid NOT NULL,
        "installment_number" integer NOT NULL,
        "principal_amount" numeric(10,2) NOT NULL,
        "interest_amount" numeric(10,2) NOT NULL DEFAULT '0.00',
        "total_amount" numeric(10,2) NOT NULL,
        "paid_amount" numeric(10,2) NOT NULL DEFAULT '0.00',
        "due_date" date NOT NULL,
        "status" "installment_status" NOT NULL DEFAULT 'pending',
        CONSTRAINT "pk_installments" PRIMARY KEY ("id"),
        CONSTRAINT "uq_installments_plan_number" UNIQUE ("payment_plan_id", "installment_number"),
        CONSTRAINT "fk_installments_payment_plan_id" FOREIGN KEY ("payment_plan_id") REFERENCES "payment_plans"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "chk_installments_paid_amount_within_total" CHECK ("paid_amount" >= 0 AND "paid_amount" <= "total_amount"),
        CONSTRAINT "chk_installments_amounts_valid" CHECK ("principal_amount" >= 0 AND "interest_amount" >= 0 AND "total_amount" > 0)
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "payment_methods" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(50) NOT NULL,
        "is_enabled" boolean NOT NULL DEFAULT true,
        "description" text,
        CONSTRAINT "pk_payment_methods" PRIMARY KEY ("id"),
        CONSTRAINT "uq_payment_methods_name" UNIQUE ("name")
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "payments" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "payment_plan_id" uuid NOT NULL,
        "installment_id" uuid,
        "patient_user_id" uuid,
        "recorded_by_user_id" uuid NOT NULL,
        "payment_method_id" uuid NOT NULL,
        "amount" numeric(10,2) NOT NULL,
        "type" "payment_type" NOT NULL,
        "amortization_mode" "amortization_mode",
        "paid_at" timestamptz NOT NULL DEFAULT now(),
        "receipt_url" text,
        "status" "payment_status" NOT NULL DEFAULT 'pending_confirmation',
        CONSTRAINT "pk_payments" PRIMARY KEY ("id"),
        CONSTRAINT "fk_payments_payment_plan_id" FOREIGN KEY ("payment_plan_id") REFERENCES "payment_plans"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "fk_payments_installment_id" FOREIGN KEY ("installment_id") REFERENCES "installments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "fk_payments_patient_user_id" FOREIGN KEY ("patient_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "fk_payments_recorded_by_user_id" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "fk_payments_payment_method_id" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT "chk_payments_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "chk_payments_amortization_has_no_installment" CHECK ("type" <> 'principal_amortization' OR "installment_id" IS NULL),
        CONSTRAINT "chk_payments_installment_payment_has_installment" CHECK ("type" <> 'installment_payment' OR "installment_id" IS NOT NULL),
        CONSTRAINT "chk_payments_amortization_mode_xor" CHECK (("type" = 'principal_amortization' AND "amortization_mode" IS NOT NULL) OR ("type" <> 'principal_amortization' AND "amortization_mode" IS NULL))
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "audit_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid,
        "action" text NOT NULL,
        "table_name" text NOT NULL,
        "record_id" uuid,
        "previous_data" jsonb,
        "new_data" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "fk_audit_logs_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
      )`,
    );

    await queryRunner.query(
      `CREATE INDEX "idx_surgeries_patient_id" ON "surgeries" ("patient_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_surgery_doctors_surgery_id" ON "surgery_doctors" ("surgery_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_surgery_doctors_doctor_id" ON "surgery_doctors" ("doctor_id")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_one_principal_per_surgery" ON "surgery_doctors" ("surgery_id") WHERE "role" = 'principal'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_installments_payment_plan_id" ON "installments" ("payment_plan_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_installments_due_date_status" ON "installments" ("due_date", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payments_payment_plan_id" ON "payments" ("payment_plan_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payments_installment_id" ON "payments" ("installment_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_payments_recorded_by_user_id" ON "payments" ("recorded_by_user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_user_id" ON "audit_logs" ("user_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_audit_logs_created_at" ON "audit_logs" ("created_at")`,
    );

    await queryRunner.query(
      `INSERT INTO "payment_methods" ("name", "is_enabled", "description") VALUES
        ('cash', true, 'Pago en ventanilla de la oficina'),
        ('bank_transfer', true, 'Transferencia bancaria'),
        ('qr', true, 'Pago por QR bancario'),
        ('card', true, 'Tarjeta de debito/credito')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(`DROP TABLE "payments"`);
    await queryRunner.query(`DROP TABLE "payment_methods"`);
    await queryRunner.query(`DROP TABLE "installments"`);
    await queryRunner.query(`DROP TABLE "payment_plans"`);
    await queryRunner.query(`DROP TABLE "surgery_doctors"`);
    await queryRunner.query(`DROP TABLE "surgeries"`);
    await queryRunner.query(`DROP TABLE "surgery_catalog"`);
    await queryRunner.query(`DROP TABLE "doctors"`);
    await queryRunner.query(`DROP TABLE "patients"`);

    await queryRunner.query(`DROP TYPE "amortization_mode"`);
    await queryRunner.query(`DROP TYPE "payment_status"`);
    await queryRunner.query(`DROP TYPE "payment_type"`);
    await queryRunner.query(`DROP TYPE "installment_status"`);
    await queryRunner.query(`DROP TYPE "payment_plan_status"`);
    await queryRunner.query(`DROP TYPE "payment_plan_type"`);
    await queryRunner.query(`DROP TYPE "surgery_doctor_role"`);
    await queryRunner.query(`DROP TYPE "surgery_status"`);
  }
}
