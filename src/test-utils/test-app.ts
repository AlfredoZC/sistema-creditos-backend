import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../app.module';

/**
 * Single bootstrap entry point for integration specs: compiles the full
 * AppModule and returns an initialized application that mirrors the runtime
 * wiring from src/main.ts (global /api prefix, validation pipe and
 * rawBody: true — required for x-hub-signature-256 verification over the
 * exact request bytes, design AD3).
 * Callers must run ensureTestDbReady() in a beforeAll hook first.
 */
export async function buildTestingApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = await createTestingNestApplication(moduleFixture);
  await app.init();
  return app;
}

/**
 * Applies the harness wiring shared with buildTestingApp to an arbitrary
 * TestingModule. Exported so specs can prove the rawBody flag is active
 * without booting the full AppModule (see test-app.spec.ts).
 */
export async function createTestingNestApplication(
  moduleFixture: TestingModule,
): Promise<INestApplication> {
  const app = moduleFixture.createNestApplication({ rawBody: true });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  return app;
}
