import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Doctor details migration: 4 profile columns mirroring `patients` exactly
 * (first_name / paternal_last_name / phone NOT NULL DEFAULT '', maternal
 * last name NULL) plus the uq_doctors_phone UNIQUE constraint (AD1).
 *
 * Fail-fast guard (AD3): the FIRST statement counts existing doctor rows —
 * with a DEFAULT '' phone, a UNIQUE constraint can only coexist with at most
 * one legacy row; anything above aborts BEFORE any ALTER so no partial state
 * is ever recorded. down() drops the constraint first, then the columns.
 */
export class DoctorDetails1786000000004 implements MigrationInterface {
  name = 'DoctorDetails1786000000004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // AD3 fail-fast guard — FIRST statement, before any ALTER.
    const rows: { count: number }[] = await queryRunner.query(
      `SELECT COUNT(*)::int AS count FROM doctors`,
    );
    if (rows[0].count > 1) {
      throw new Error(
        `Cannot run DoctorDetails1786000000004: doctors has ${rows[0].count} rows; ` +
          `adding UNIQUE phone with DEFAULT '' requires at most one legacy row. ` +
          `Reconcile doctor phones before migrating.`,
      );
    }

    await queryRunner.query(
      `ALTER TABLE "doctors" ADD COLUMN "first_name" character varying(50) NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "doctors" ADD COLUMN "paternal_last_name" character varying(50) NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "doctors" ADD COLUMN "maternal_last_name" character varying(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "doctors" ADD COLUMN "phone" character varying(50) NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "doctors" ADD CONSTRAINT "uq_doctors_phone" UNIQUE ("phone")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Constraint first, then the columns (index-dependent drop order).
    await queryRunner.query(
      `ALTER TABLE "doctors" DROP CONSTRAINT "uq_doctors_phone"`,
    );
    await queryRunner.query(`ALTER TABLE "doctors" DROP COLUMN "phone"`);
    await queryRunner.query(`ALTER TABLE "doctors" DROP COLUMN "maternal_last_name"`);
    await queryRunner.query(`ALTER TABLE "doctors" DROP COLUMN "paternal_last_name"`);
    await queryRunner.query(`ALTER TABLE "doctors" DROP COLUMN "first_name"`);
  }
}