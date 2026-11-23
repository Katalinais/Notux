import { createTestApp, login, type TestContext } from './app';

describe('auth flow with Google mocked (e2e)', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });
  afterAll(() => ctx.app.close());

  it('GET /auth/google rejects redirects outside FRONTEND_ORIGINS', async () => {
    const res = await ctx.http().get('/auth/google').query({ redirect: 'https://evil.example/' }).expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, code: 'INVALID_REDIRECT' });
    await ctx.http().get('/auth/google').expect(400);
  });

  it('GET /auth/google redirects to Google with a sealed state and sets the nonce cookie', async () => {
    const res = await ctx.http().get('/auth/google').query({ redirect: 'http://localhost:8080/' }).expect(302);
    const url = new URL(res.headers.location);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('state')).toMatch(/^v1\./);
    expect(String(res.headers['set-cookie'])).toMatch(/notux_oauth_nonce=.*HttpOnly.*SameSite=Lax/i);
  });

  it('callback without the browser cookie redirects with auth_error=invalid_state', async () => {
    const start = await ctx.http().get('/auth/google').query({ redirect: 'http://localhost:8080/' });
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const res = await ctx.http().get('/auth/google/callback').query({ code: 'good-google-code', state }).expect(302);
    expect(res.headers.location).toBe('http://localhost:8080/?auth_error=invalid_state');
  });

  it('callback forwards a Google denial as auth_error=access_denied', async () => {
    const start = await ctx.http().get('/auth/google').query({ redirect: 'http://localhost:8080/app?x=1' });
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const cookie = String(start.headers['set-cookie']).split(';')[0];
    const res = await ctx
      .http()
      .get('/auth/google/callback')
      .query({ error: 'access_denied', state })
      .set('Cookie', cookie)
      .expect(302);
    expect(res.headers.location).toBe('http://localhost:8080/app?x=1&auth_error=access_denied');
  });

  it('callback with a forged state -> 400, no redirect', async () => {
    await ctx.http().get('/auth/google/callback').query({ code: 'x', state: 'v1.forged.state.value' }).expect(400);
  });

  it('exchange -> me -> refresh -> logout, with refresh rotation and reuse detection', async () => {
    const session = await login(ctx);
    expect(session.expiresIn).toBe(900);
    expect(session.user).toEqual({
      id: expect.any(String),
      email: 'estudiante@example.com',
      name: 'Ana Estudiante',
      picture: 'https://example.com/ana.png',
      driveConnected: true,
    });

    // Google's refresh token is stored encrypted, never in clear.
    const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: session.user.id } });
    expect(stored.googleRefreshTokenEnc).toMatch(/^v1\./);
    expect(stored.googleRefreshTokenEnc).not.toContain('google-refresh-token-1');

    const me = await ctx.http().get('/users/me').set('Authorization', `Bearer ${session.accessToken}`).expect(200);
    expect(me.body).toEqual(session.user);

    const refreshed = await ctx.http().post('/auth/refresh').send({ refreshToken: session.refreshToken }).expect(200);
    expect(refreshed.body).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: 900,
    });
    expect(refreshed.body.refreshToken).not.toBe(session.refreshToken);
    await ctx.http().get('/users/me').set('Authorization', `Bearer ${refreshed.body.accessToken}`).expect(200);

    // Reusing the rotated token kills the family, including the newest token.
    const reuse = await ctx.http().post('/auth/refresh').send({ refreshToken: session.refreshToken }).expect(401);
    expect(reuse.body).toMatchObject({ statusCode: 401, code: 'INVALID_REFRESH_TOKEN' });
    await ctx.http().post('/auth/refresh').send({ refreshToken: refreshed.body.refreshToken }).expect(401);

    // A fresh login; logout is 204 and idempotent, and the token stops working.
    const second = await login(ctx);
    await ctx.http().post('/auth/logout').send({ refreshToken: second.refreshToken }).expect(204);
    await ctx.http().post('/auth/logout').send({ refreshToken: second.refreshToken }).expect(204);
    await ctx.http().post('/auth/logout').send({ refreshToken: 'never-issued' }).expect(204);
    await ctx.http().post('/auth/refresh').send({ refreshToken: second.refreshToken }).expect(401);
  });

  it('a login code works only once', async () => {
    const start = await ctx.http().get('/auth/google').query({ redirect: 'http://localhost:8080/' });
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const cookie = String(start.headers['set-cookie']).split(';')[0];
    const cb = await ctx
      .http()
      .get('/auth/google/callback')
      .query({ code: 'good-google-code', state })
      .set('Cookie', cookie);
    const code = new URL(cb.headers.location).searchParams.get('login_code');

    await ctx.http().post('/auth/exchange').send({ code }).expect(200);
    const again = await ctx.http().post('/auth/exchange').send({ code }).expect(401);
    expect(again.body).toMatchObject({ code: 'INVALID_LOGIN_CODE' });
  });
});
