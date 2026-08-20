import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as request from 'supertest';
import { DataSource } from 'typeorm';
import { SurgeryStatus, UserRole } from '../common/enums';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';
import { uniqueMobile8 } from '../test-utils/unique-phone';

jest.setTimeout(60000);

const RUN_SUFFIX = `${process.pid}${Date.now()}`;
const SHORT_SUFFIX = RUN_SUFFIX.slice(-10);
let uniqueCounter = 0;

interface IdRow {
  id: string;
}

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Regla de negocio: el auxiliar asiste, el encargado responde.
 *
 * Solo el medico asignado como `principal` puede dar una cirugia por realizada
 * o escribir su nota quirurgica. Un asistente o un anestesiologo, aunque esten
 * asignados a la misma cirugia, no pueden. Cancelar sigue siendo una decision
 * administrativa: ningun medico la toma.
 */
describe('acciones del medico sobre su cirugia', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let jwtService: JwtService;

  let principalToken: string;
  let assistantToken: string;
  let outsiderToken: string;
  let officeToken: string;
  let surgeryId: string;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
    dataSource = app.get(DataSource);
    jwtService = app.get(JwtService);

    const principalUserId = await insertUser(UserRole.DOCTOR);
    const assistantUserId = await insertUser(UserRole.DOCTOR);
    const outsiderUserId = await insertUser(UserRole.DOCTOR);
    const officeUserId = await insertUser(UserRole.OFFICE);

    principalToken = jwtService.sign({ id: principalUserId });
    assistantToken = jwtService.sign({ id: assistantUserId });
    outsiderToken = jwtService.sign({ id: outsiderUserId });
    officeToken = jwtService.sign({ id: officeUserId });

    const principalId = await insertDoctor(principalUserId);
    const assistantId = await insertDoctor(assistantUserId);
    await insertDoctor(outsiderUserId);

    surgeryId = await insertSurgery();
    await assign(surgeryId, principalId, 'principal');
    await assign(surgeryId, assistantId, 'assistant');
  });

  afterAll(async () => {
    await app.close();
  });

  async function insertUser(role: UserRole): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO users (email, password, name, role, is_active)
       VALUES ($1, 'hashed-password', $2, $3, true)
       RETURNING id`,
      [
        `acciones.${role}.${RUN_SUFFIX}.${uniqueCounter++}@example.com`,
        `Acciones ${role}`,
        role,
      ],
    );
    return rows[0].id;
  }

  async function insertDoctor(userId: string): Promise<string> {
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO doctors
         (user_id, specialty, professional_license, first_name, paternal_last_name, phone)
       VALUES ($1, 'Cirugia general', $2, 'Doc', 'Acciones', $3)
       RETURNING id`,
      [userId, `LICA${SHORT_SUFFIX}${uniqueCounter++}`, uniqueMobile8()],
    );
    return rows[0].id;
  }

  async function insertSurgery(): Promise<string> {
    const patientRows: IdRow[] = await dataSource.query(
      `INSERT INTO patients (identity_document, first_name, paternal_last_name, phone)
       VALUES ($1, 'Paciente', 'Acciones', $2)
       RETURNING id`,
      [`A${SHORT_SUFFIX}${uniqueCounter++}`, uniqueMobile8()],
    );
    const catalogRows: IdRow[] = await dataSource.query(
      `INSERT INTO surgery_catalog (name, base_cost)
       VALUES ($1, '4000.00') RETURNING id`,
      [`Acciones-${RUN_SUFFIX}-${uniqueCounter++}`],
    );
    const rows: IdRow[] = await dataSource.query(
      `INSERT INTO surgeries (patient_id, surgery_catalog_id, scheduled_date, total_cost)
       VALUES ($1, $2, $3, '4000.00')
       RETURNING id`,
      [patientRows[0].id, catalogRows[0].id, isoDaysFromToday(-1)],
    );
    return rows[0].id;
  }

  async function assign(
    surgery: string,
    doctor: string,
    role: string,
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO surgery_doctors (surgery_id, doctor_id, role)
       VALUES ($1, $2, $3)`,
      [surgery, doctor, role],
    );
  }

  function patchStatus(token: string, status: SurgeryStatus, id = surgeryId) {
    return request(app.getHttpServer())
      .patch(`/api/surgeries/${id}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send({ status });
  }

  function patchNotes(token: string, notes: string, id = surgeryId) {
    return request(app.getHttpServer())
      .patch(`/api/surgeries/${id}/notes`)
      .set('Authorization', `Bearer ${token}`)
      .send({ notes });
  }

  describe('marcar como realizada', () => {
    it('deja al medico principal darla por realizada', async () => {
      const response = await patchStatus(
        principalToken,
        SurgeryStatus.PERFORMED,
      ).expect(200);

      expect(response.body.status).toBe(SurgeryStatus.PERFORMED);
    });

    it('no deja al asistente cambiar el estado', async () => {
      await patchStatus(assistantToken, SurgeryStatus.PERFORMED).expect(403);
    });

    it('no deja a un medico ajeno a la cirugia', async () => {
      await patchStatus(outsiderToken, SurgeryStatus.PERFORMED).expect(403);
    });

    // Cancelar es una decision administrativa: implica plata y plan de pago.
    it('no deja al principal cancelar la cirugia', async () => {
      await patchStatus(principalToken, SurgeryStatus.CANCELLED).expect(403);
    });

    it('el staff sigue pudiendo cualquier transicion', async () => {
      await patchStatus(officeToken, SurgeryStatus.SCHEDULED).expect(200);
    });
  });

  describe('nota quirurgica', () => {
    it('deja al medico principal escribir la nota', async () => {
      const response = await patchNotes(
        principalToken,
        'Sin complicaciones. Alta en 24 horas.',
      ).expect(200);

      expect(response.body.notes).toBe('Sin complicaciones. Alta en 24 horas.');
    });

    it('no deja al asistente escribirla', async () => {
      await patchNotes(assistantToken, 'intento').expect(403);
    });

    it('no deja a un anonimo escribirla', async () => {
      await request(app.getHttpServer())
        .patch(`/api/surgeries/${surgeryId}/notes`)
        .send({ notes: 'intento' })
        .expect(401);
    });

    it('el staff tambien puede escribirla', async () => {
      await patchNotes(officeToken, 'Nota de la oficina').expect(200);
    });
  });
});
