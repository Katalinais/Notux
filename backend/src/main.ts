import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { existsSync } from 'node:fs';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { EnvValidationError, validateEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Local development: read backend/.env. In production the platform injects the variables.
  if (existsSync('.env')) process.loadEnvFile('.env');

  let port: number;
  try {
    port = validateEnv(process.env).port;
  } catch (err) {
    if (err instanceof EnvValidationError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app);
  await app.listen(port);
  Logger.log(`Notux API listening on http://localhost:${port} (docs at /docs)`, 'Bootstrap');
}

void bootstrap();
