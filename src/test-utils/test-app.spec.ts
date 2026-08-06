import { Controller, INestApplication, Post, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Request } from 'express';
import * as request from 'supertest';
import { ensureTestDbReady } from './setup-test-db';
import {
  buildTestingApp,
  createTestingNestApplication,
} from './test-app';

jest.setTimeout(60000);

// Minimal probe used to prove rawBody wiring without a controller that reads
// the raw body (the webhook controller lands in a later slice).
@Controller('rawbody-probe')
class RawBodyProbeController {
  @Post()
  rawBodyByteCount(@Req() req: Request) {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    return { rawBodyBytes: rawBody ? Buffer.byteLength(rawBody) : null };
  }
}

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

  it('wires rawBody: true so req.rawBody carries the exact request bytes', async () => {
    // Same construction path as buildTestingApp (shared helper) — proves the
    // integration harness mirrors main.ts, so webhook signature verification
    // over raw bytes works in specs.
    const moduleFixture = await Test.createTestingModule({
      controllers: [RawBodyProbeController],
    }).compile();
    const probeApp = await createTestingNestApplication(moduleFixture);
    await probeApp.init();

    const rawBody = JSON.stringify({ probe: 'raw-body-proof', n: 42 });
    const response = await request(probeApp.getHttpServer())
      .post('/api/rawbody-probe')
      .set('Content-Type', 'application/json')
      .send(rawBody);

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      rawBodyBytes: Buffer.byteLength(rawBody, 'utf8'),
    });

    await probeApp.close();
  });
});
