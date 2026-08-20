import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express, { type Express } from 'express';
import { AppModule } from '../src/app.module';
import { resolveCorsOrigins } from '../src/common/cors.util';

/**
 * Punto de entrada para Vercel: la misma aplicacion de `src/main.ts`, pero
 * expuesta como funcion en vez de como servidor propio.
 *
 * La instancia se cachea en el ambito del modulo a proposito. Vercel reutiliza
 * el proceso entre invocaciones mientras el contenedor sigue tibio; recrear
 * Nest -y con el, el pool de conexiones a Postgres- en cada request agotaria
 * los limites de conexion de la base en el primer pico de trafico.
 */
let cachedServer: Express | null = null;

async function bootstrapServer(): Promise<Express> {
  const expressApp = express();

  const app = await NestFactory.create(
    AppModule,
    new ExpressAdapter(expressApp),
    // rawBody: la verificacion de firma del webhook de WhatsApp necesita los
    // bytes exactos del cuerpo, antes de parsear.
    { rawBody: true },
  );

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  app.enableCors({
    origin: resolveCorsOrigins(process.env.CORS_ORIGINS),
    credentials: true,
  });

  await app.init();
  return expressApp;
}

export default async function handler(
  request: unknown,
  response: unknown,
): Promise<void> {
  if (!cachedServer) {
    cachedServer = await bootstrapServer();
  }
  cachedServer(request as never, response as never);
}
