import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Auth refactor: replace the legacy `roles text[]` model with a single
 * `user_role` enum column and align the users table with the ES source
 * schema (varchar lengths, gen_random_uuid() default, snake_case is_active).
 *
 * Legacy data mapping (design section 9): the first element of the roles
 * array wins — 'admin' and 'super-user' map to 'admin' (privilege-preserving,
 * AD9), everything else (including legacy 'user') maps to 'patient'.
 */
export class AuthSingleRole1786000000001 implements MigrationInterface {
  name = 'AuthSingleRole1786000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "user_role" AS ENUM ('patient', 'doctor', 'office', 'admin')`,
    );
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "role" "user_role"`);
    await queryRunner.query(
      `UPDATE "users" SET "role" = CASE "roles"[1]
         WHEN 'admin' THEN 'admin'::"user_role"
         WHEN 'super-user' THEN 'admin'::"user_role"
         ELSE 'patient'::"user_role"
       END`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "role" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "roles", DROP COLUMN "lastName"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT gen_random_uuid()`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "email" TYPE character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password" TYPE character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "name" TYPE character varying(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" RENAME COLUMN "isActive" TO "is_active"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" RENAME COLUMN "is_active" TO "isActive"`,
    );
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "name" TYPE text`);
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "password" TYPE text`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "email" TYPE text`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ALTER COLUMN "id" SET DEFAULT uuid_generate_v4()`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "lastName" text NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "roles" text array NOT NULL DEFAULT '{user}'`,
    );
    await queryRunner.query(
      `UPDATE "users" SET "roles" = CASE WHEN "role" = 'patient' THEN '{user}'::text[] ELSE ARRAY["role"::text] END`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "role"`);
    await queryRunner.query(`DROP TYPE "user_role"`);
  }
}
