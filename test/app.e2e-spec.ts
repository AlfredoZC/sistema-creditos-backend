import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ensureTestDbReady } from '../src/test-utils/setup-test-db';
import { buildTestingApp } from '../src/test-utils/test-app';

describe('AppController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/auth/check-status without token is rejected (401)', () => {
    return request(app.getHttpServer())
      .get('/api/auth/check-status')
      .expect(401);
  });
});
