import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';

/**
 * Single bootstrap entry point for integration specs: compiles the full
 * AppModule and returns an initialized application that mirrors the runtime
 * wiring from src/main.ts (global /api prefix and validation pipe).
 * Callers must run ensureTestDbReady() in a beforeAll hook first.
 */
export async function buildTestingApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  await app.init();
  return app;
}
