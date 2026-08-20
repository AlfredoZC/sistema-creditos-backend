import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Recordatorios de cuota: una fila por (cuota, tipo) enviado.
 *
 * La UNIQUE (installment_id, kind) NO es una optimizacion: ES el mecanismo de
 * idempotencia. El job diario inserta la fila ANTES de despachar, asi que si
 * corre dos veces el mismo dia -o dos instancias a la vez- la segunda choca
 * contra la restriccion y no manda un segundo WhatsApp al paciente.
 *
 * `dispatch_id` queda NULL cuando el despacho falla: la fila igual se conserva
 * para que un error del proveedor no dispare reintentos infinitos en cada
 * corrida. El operador puede borrar la fila para forzar un reenvio.
 */
export class InstallmentReminders1786000000005 implements MigrationInterface {
  name = 'InstallmentReminders1786000000005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "installment_reminder_kind" AS ENUM ('due_soon', 'overdue')`,
    );
    await queryRunner.query(
      `CREATE TABLE "installment_reminders" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "installment_id" uuid NOT NULL,
        "kind" "installment_reminder_kind" NOT NULL,
        "dispatch_id" uuid,
        "sent_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "pk_installment_reminders" PRIMARY KEY ("id"),
        CONSTRAINT "uq_installment_reminders_installment_kind" UNIQUE ("installment_id", "kind"),
        CONSTRAINT "fk_installment_reminders_installment_id" FOREIGN KEY ("installment_id") REFERENCES "installments"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "fk_installment_reminders_dispatch_id" FOREIGN KEY ("dispatch_id") REFERENCES "whatsapp_dispatches"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_installment_reminders_sent_at" ON "installment_reminders" ("sent_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "idx_installment_reminders_sent_at"`);
    await queryRunner.query(`DROP TABLE "installment_reminders"`);
    await queryRunner.query(`DROP TYPE "installment_reminder_kind"`);
  }
}
