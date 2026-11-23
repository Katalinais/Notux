import { type INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import helmet from 'helmet';
import { APP_CONFIG, type AppConfig } from './config/env';

export const BACKUP_BODY_LIMIT = '25mb';
export const DEFAULT_BODY_LIMIT = '100kb';
export const AI_BODY_LIMIT = '512kb';

/**
 * Everything main.ts and the e2e tests share. The app must be created with `{ bodyParser: false }`
 * so the per-route JSON limits below are the only body parsers.
 */
export function configureApp(app: NestExpressApplication): INestApplication {
  const config = app.get<AppConfig>(APP_CONFIG);

  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(
    helmet({
      // Over plain http (local dev) these would break the Swagger UI and pin localhost to https.
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: config.isProduction ? [] : null } },
      strictTransportSecurity: config.isProduction,
    }),
  );
  app.enableCors({
    origin: config.frontendOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Base-Version'],
    exposedHeaders: ['X-Sync-Version'],
    credentials: false,
    maxAge: 600,
  });

  // Backups can be big (photos/audio as base64): 25 MB there, small bodies everywhere else.
  // The raw bytes are kept so the backup is stored (in Drive, or synced) exactly as sent.
  app.use(
    ['/drive/backups', '/sync/data'],
    json({
      limit: BACKUP_BODY_LIMIT,
      verify: (req, _res, buf) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  // Notes sent to generate a quiz (up to ~60,000 characters; accents take 2 bytes each).
  app.use('/ai/quiz', json({ limit: AI_BODY_LIMIT }));
  app.use(json({ limit: DEFAULT_BODY_LIMIT }));

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Notux API')
        .setDescription('Login, data sync across devices and Google Drive backups for the Notux PWA.')
        .setVersion('1')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('docs', app, document);
  }
  return app;
}
