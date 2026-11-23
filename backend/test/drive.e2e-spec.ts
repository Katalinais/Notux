import { GoogleApiError } from '../src/google/google-errors';
import { createTestApp, login, type TestContext } from './app';

describe('/drive/backups with the Drive client mocked (e2e)', () => {
  let ctx: TestContext;
  let auth: { Authorization: string };

  beforeAll(async () => {
    ctx = await createTestApp();
    const session = await login(ctx);
    auth = { Authorization: `Bearer ${session.accessToken}` };
  });
  afterAll(() => ctx.app.close());

  const backup = (extra: Record<string, unknown> = {}) => ({
    app: 'notux',
    format: 1,
    dbVersion: 5,
    exportedAt: '2026-11-23T15:30:00.000Z',
    tasks: [{ id: 't1', title: 'Estudiar cálculo' }],
    ...extra,
  });

  it('requires a token', async () => {
    await ctx.http().get('/drive/backups').expect(401);
    await ctx.http().post('/drive/backups').send(backup()).expect(401);
  });

  it('lists nothing before the first backup', async () => {
    const res = await ctx.http().get('/drive/backups').set(auth).expect(200);
    expect(res.body).toEqual([]);
  });

  it('rejects bodies that are not Notux backups', async () => {
    for (const body of [{ app: 'other', format: 1 }, { app: 'notux', format: 2 }, [1, 2]]) {
      const res = await ctx.http().post('/drive/backups').set(auth).send(body).expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, code: 'INVALID_BACKUP' });
    }
  });

  it('uploads, lists, downloads byte-for-byte and deletes', async () => {
    // Odd spacing on purpose: the stored file must be exactly what was sent.
    const raw = `{"app":"notux",  "format":1, "notes":[{"title":"Ñandú"}]}`;
    const created = await ctx
      .http()
      .post('/drive/backups')
      .set(auth)
      .set('Content-Type', 'application/json')
      .send(raw)
      .expect(201);
    expect(created.body).toEqual({
      id: expect.any(String),
      name: expect.stringMatching(/^notux-respaldo-\d{4}-\d{2}-\d{2}-\d{4}\.json$/),
      createdTime: expect.any(String),
      size: Buffer.byteLength(raw),
    });

    const list = await ctx.http().get('/drive/backups').set(auth).expect(200);
    expect(list.body).toEqual([created.body]);

    const download = await ctx.http().get(`/drive/backups/${created.body.id}`).set(auth).buffer(true).expect(200);
    expect(download.headers['content-type']).toMatch(/application\/json/);
    expect(download.text).toBe(raw);

    await ctx.http().delete(`/drive/backups/${created.body.id}`).set(auth).expect(204);
    await ctx.http().get(`/drive/backups/${created.body.id}`).set(auth).expect(404);
  });

  it('keeps only the newest 10 backups, listed newest first', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await ctx
        .http()
        .post('/drive/backups')
        .set(auth)
        .send(backup({ n: i }))
        .expect(201);
      ids.push(res.body.id);
    }
    expect(ctx.drive.backups()).toHaveLength(10);
    const list = await ctx.http().get('/drive/backups').set(auth).expect(200);
    expect(list.body.map((b: { id: string }) => b.id)).toEqual(ids.slice(2).reverse());
  });

  it('404 for files that are not Notux backups', async () => {
    await ctx.http().get('/drive/backups/someone-elses-file-id').set(auth).expect(404);
    const folder = [...ctx.drive.files.values()].find((f) => f.name === 'Notux')!;
    await ctx.http().get(`/drive/backups/${folder.id}`).set(auth).expect(404);
  });

  it('accepts large backups (photos as base64) under 25 MB, rejects bigger ones with 413', async () => {
    const big = backup({ photo: 'A'.repeat(5 * 1024 * 1024) });
    await ctx.http().post('/drive/backups').set(auth).send(big).expect(201);
    const tooBig = backup({ photo: 'A'.repeat(26 * 1024 * 1024) });
    await ctx.http().post('/drive/backups').set(auth).send(tooBig).expect(413);
  });

  it('other routes keep a small body limit', async () => {
    await ctx
      .http()
      .post('/auth/refresh')
      .send({ refreshToken: 'x'.repeat(200 * 1024) })
      .expect(413);
  });

  it('maps Google failures: 502 DRIVE_UNAVAILABLE', async () => {
    ctx.drive.failNext = new GoogleApiError(503, 'backendError', 'Drive is down');
    const res = await ctx.http().get('/drive/backups').set(auth).expect(502);
    expect(res.body).toMatchObject({ statusCode: 502, code: 'DRIVE_UNAVAILABLE' });
  });

  it('maps a revoked Google grant to 403 DRIVE_NOT_AUTHORIZED and reports driveConnected=false', async () => {
    ctx.google.revoked = true;
    const res = await ctx.http().get('/drive/backups').set(auth).expect(403);
    expect(res.body).toMatchObject({ statusCode: 403, code: 'DRIVE_NOT_AUTHORIZED' });

    const me = await ctx.http().get('/users/me').set(auth).expect(200);
    expect(me.body.driveConnected).toBe(false);
    // Stays 403 until the user logs in with Google again.
    ctx.google.revoked = false;
    await ctx.http().get('/drive/backups').set(auth).expect(403);
    const again = await login(ctx);
    await ctx.http().get('/drive/backups').set('Authorization', `Bearer ${again.accessToken}`).expect(200);
  });
});
