import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ensureTestDbReady } from '../test-utils/setup-test-db';
import { buildTestingApp } from '../test-utils/test-app';

jest.setTimeout(60000);

/**
 * Los endpoints de media (Cloudinary y foto de perfil) quedaron sin guard: el
 * `@Auth(ValidRoles.admin)` estaba comentado en el controlador. Sin guard,
 * cualquier anonimo puede subir a la cuenta de Cloudinary o borrar la imagen
 * de perfil de cualquier persona pasando su id. Este spec fija el contrato:
 * ninguno de esos endpoints responde sin un token valido.
 */
describe('media endpoints require authentication', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects anonymous cloudinary uploads', async () => {
    await request(app.getHttpServer())
      .post('/api/cloud/upload-image')
      .expect(401);
  });

  it('rejects anonymous cloudinary preset creation', async () => {
    await request(app.getHttpServer())
      .post('/api/cloud/upload-preset')
      .expect(401);
  });

  it('rejects anonymous cloudinary deletions', async () => {
    await request(app.getHttpServer())
      .delete('/api/cloud/delete/some-public-id')
      .expect(401);
  });

  it('rejects anonymous profile image uploads', async () => {
    await request(app.getHttpServer())
      .patch('/api/profile/upload-profile-image/1')
      .expect(401);
  });

  it('rejects anonymous profile image deletions', async () => {
    await request(app.getHttpServer())
      .delete('/api/profile/delete-image/some-profile-id')
      .expect(401);
  });
});
