import { createTestApp, type TestContext } from './app';

describe('health, users, docs (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());

  it('GET /health -> 200 with the database up', async () => {
    const res = await ctx.http().get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', info: { database: { status: 'up' } } });
  });

  it('GET /users/me without a token -> 401', async () => {
    const res = await ctx.http().get('/users/me').expect(401);
    expect(res.body.statusCode).toBe(401);
  });

  it('GET /users/me with a garbage or foreign token -> 401', async () => {
    await ctx.http().get('/users/me').set('Authorization', 'Bearer not.a.jwt').expect(401);
    // Signed with another secret.
    const foreign =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4IiwiaXNzIjoibm90dXgiLCJhdWQiOiJub3R1eC1hcGkifQ.' +
      'Zm9yZ2VkLXNpZ25hdHVyZS1mb3JnZWQtc2lnbmF0dXJl';
    await ctx.http().get('/users/me').set('Authorization', `Bearer ${foreign}`).expect(401);
  });

  it('CORS allows FRONTEND_ORIGINS only', async () => {
    const ok = await ctx
      .http()
      .options('/users/me')
      .set('Origin', 'http://localhost:8080')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:8080');

    const bad = await ctx
      .http()
      .options('/users/me')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'GET');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers (helmet) and serves Swagger at /docs', async () => {
    const res = await ctx.http().get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    await ctx.http().get('/docs').expect(200);
    const spec = await ctx.http().get('/docs-json').expect(200);
    expect(Object.keys(spec.body.paths)).toEqual(
      expect.arrayContaining(['/health', '/auth/exchange', '/users/me', '/drive/backups', '/drive/backups/{id}']),
    );
  });

  it('rejects unknown body fields (whitelist + forbidNonWhitelisted)', async () => {
    await ctx.http().post('/auth/refresh').send({ refreshToken: 'x', extra: 1 }).expect(400);
  });
});
