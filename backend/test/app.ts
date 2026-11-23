import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DriveClient } from '../src/drive/drive.client';
import { GoogleOAuthService } from '../src/google/google-oauth.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { FakeDriveClient, FakeGoogleOAuth } from './fakes';

export interface TestContext {
  app: INestApplication<App>;
  http: () => ReturnType<typeof request>;
  google: FakeGoogleOAuth;
  drive: FakeDriveClient;
  prisma: PrismaService;
}

/** Boots the real app (real Postgres) with Google replaced by in-memory fakes. */
export async function createTestApp(): Promise<TestContext> {
  const google = new FakeGoogleOAuth();
  const drive = new FakeDriveClient();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GoogleOAuthService)
    .useValue(google)
    .overrideProvider(DriveClient)
    .useValue(drive)
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false, logger: false });
  configureApp(app);
  await app.init();

  const prisma = app.get(PrismaService);
  await prisma.refreshToken.deleteMany();
  await prisma.loginCode.deleteMany();
  await prisma.user.deleteMany();

  return { app, http: () => request(app.getHttpServer()), google, drive, prisma };
}

/** Runs the whole Google login dance and returns the tokens from /auth/exchange. */
export async function login(ctx: TestContext) {
  const start = await ctx.http().get('/auth/google').query({ redirect: 'http://localhost:8080/' }).expect(302);
  const state = new URL(start.headers.location).searchParams.get('state')!;
  const cookie = ([] as string[]).concat(start.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]);

  const callback = await ctx
    .http()
    .get('/auth/google/callback')
    .query({ code: 'good-google-code', state })
    .set('Cookie', cookie)
    .expect(302);
  const code = new URL(callback.headers.location).searchParams.get('login_code')!;

  const res = await ctx.http().post('/auth/exchange').send({ code }).expect(200);
  return res.body as {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    user: { id: string; email: string; driveConnected: boolean };
  };
}
