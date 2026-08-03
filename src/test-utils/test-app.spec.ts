import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ensureTestDbReady } from './setup-test-db';
import { buildTestingApp } from './test-app';

jest.setTimeout(60000);

describe('buildTestingApp (harness contract, design section 12)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    await ensureTestDbReady();
    app = await buildTestingApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves routes behind the global api prefix with the auth guard active', async () => {
    const response = await request(app.getHttpServer()).get('/api/auth/check-status');
    expect(response.status).toBe(401);
  });

  it('rejects invalid bodies through the global validation pipe', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({});
    expect(response.status).toBe(400);
  });
});
