import { JwtService } from '@nestjs/jwt';
import { createTestApp, login, type TestContext } from './app';

const backup = (marker: string) => ({ app: 'notux', format: 1, dbVersion: 7, tasks: [{ id: 1, title: marker }] });

describe('data sync (e2e)', () => {
  let ctx: TestContext;
  let auth: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    auth = `Bearer ${(await login(ctx)).accessToken}`;
  });
  afterAll(() => ctx.app.close());

  const put = (base: string | undefined, body: unknown) => {
    const req = ctx.http().put('/sync/data').set('Authorization', auth);
    if (base !== undefined) req.set('X-Base-Version', base);
    return req.send(body as object);
  };

  it('needs a session', async () => {
    await ctx.http().get('/sync').expect(401);
    await ctx.http().get('/sync/data').expect(401);
    await ctx.http().put('/sync/data').send(backup('x')).expect(401);
  });

  it('starts empty', async () => {
    const res = await ctx.http().get('/sync').set('Authorization', auth).expect(200);
    expect(res.body).toEqual({ version: 0, updatedAt: null, size: 0 });
    await ctx.http().get('/sync/data').set('Authorization', auth).expect(204);
  });

  it('stores versions and rejects uploads based on an old one', async () => {
    const first = await put('0', backup('uno')).expect(200);
    expect(first.body).toMatchObject({ version: 1, updatedAt: expect.any(String), size: expect.any(Number) });

    // A second device that also thought it was first loses.
    const late = await put('0', backup('otro')).expect(409);
    expect(late.body).toMatchObject({ statusCode: 409, code: 'SYNC_CONFLICT' });

    await put('1', backup('dos')).expect(200);
    await put('1', backup('viejo')).expect(409);

    const data = await ctx.http().get('/sync/data').set('Authorization', auth).expect(200);
    expect(data.headers['x-sync-version']).toBe('2');
    expect(data.body).toEqual(backup('dos'));
    const state = await ctx.http().get('/sync').set('Authorization', auth).expect(200);
    expect(state.body.version).toBe(2);
  });

  it('keeps the exact bytes it was sent', async () => {
    const raw = '{"app":"notux","format":1,"tasks":[{"id":1,"title":"ñandú ✓"}],   "z":1}';
    await put('2', JSON.parse(raw)).expect(200); // advance to 3 first
    await ctx
      .http()
      .put('/sync/data')
      .set('Authorization', auth)
      .set('X-Base-Version', '3')
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(200);
    const res = await ctx
      .http()
      .get('/sync/data')
      .set('Authorization', auth)
      .buffer(true)
      .parse((r, cb) => {
        let text = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (text += c));
        r.on('end', () => cb(null, text));
      });
    expect(res.body).toBe(raw);
  });

  it('validates the base version and the body', async () => {
    for (const base of [undefined, '', '-1', 'abc', '1.5']) {
      const res = await put(base, backup('x')).expect(400);
      expect(res.body.code).toBe('INVALID_BASE_VERSION');
    }
    const res = await put('4', { app: 'otra-app', format: 1 }).expect(400);
    expect(res.body.code).toBe('INVALID_BACKUP');
  });

  it("users don't see each other's data", async () => {
    const other = await ctx.prisma.user.create({ data: { email: 'b@example.com', username: 'b' } });
    const token = await ctx.app
      .get(JwtService)
      .signAsync({ sub: other.id }, { issuer: 'notux', audience: 'notux-api', algorithm: 'HS256' });
    const res = await ctx.http().get('/sync').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.version).toBe(0);
  });
});
