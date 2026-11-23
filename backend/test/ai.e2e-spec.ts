import { AiClient } from '../src/ai/ai.service';
import { createTestApp, login, type TestContext } from './app';

const goodQuiz = {
  title: 'Bases de datos',
  questions: [
    {
      question: '¿Qué devuelve un INNER JOIN?',
      options: ['Solo las filas que coinciden', 'Todo de la izquierda', 'Todo de ambos lados', 'Ninguna fila'],
      correctIndex: 0,
      explanation: 'Solo las coincidencias de ambas tablas.',
      sourceNote: 'Tipos de JOIN',
    },
  ],
};
const notes = [{ title: 'Tipos de JOIN', text: 'INNER: solo coincidencias. LEFT: todo lo de la izquierda.' }];

describe('AI quiz (e2e, Claude mocked)', () => {
  let ctx: TestContext;
  let auth: string;
  let client: AiClient;

  beforeAll(async () => {
    ctx = await createTestApp();
    auth = `Bearer ${(await login(ctx)).accessToken}`;
    client = ctx.app.get(AiClient);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => ctx.app.close());

  const post = (body: unknown) =>
    ctx
      .http()
      .post('/ai/quiz')
      .set('Authorization', auth)
      .send(body as object);

  it('needs a session', async () => {
    await ctx.http().post('/ai/quiz').send({ notes, count: 5 }).expect(401);
  });

  it('answers 503 AI_NOT_CONFIGURED without an API key', async () => {
    const res = await post({ notes, count: 5 }).expect(503);
    expect(res.body.code).toBe('AI_NOT_CONFIGURED');
  });

  it('returns the quiz and sends the notes to the model', async () => {
    jest.spyOn(client, 'configured', 'get').mockReturnValue(true);
    const generate = jest.spyOn(client, 'generateQuiz').mockResolvedValue(goodQuiz);
    const res = await post({ notes: [...notes, { title: 'Vacía', text: '   ' }], count: 5 }).expect(200);
    expect(res.body).toEqual(goodQuiz);
    expect(generate).toHaveBeenCalledWith(notes, 5); // empty notes are dropped
  });

  it('maps a refusal or an unusable answer to 422 and errors to 503', async () => {
    jest.spyOn(client, 'configured', 'get').mockReturnValue(true);
    const generate = jest.spyOn(client, 'generateQuiz');
    generate.mockResolvedValueOnce(null);
    expect((await post({ notes, count: 5 }).expect(422)).body.code).toBe('AI_REFUSED');
    generate.mockResolvedValueOnce({ title: 'x', questions: [{ ...goodQuiz.questions[0], options: ['solo una'] }] });
    expect((await post({ notes, count: 5 }).expect(422)).body.code).toBe('AI_REFUSED');
    generate.mockRejectedValueOnce(new Error('boom'));
    expect((await post({ notes, count: 5 }).expect(503)).body.code).toBe('AI_UNAVAILABLE');
  });

  // A fresh app: the earlier tests already used up this route's per-minute limit.
  describe('with a fresh rate limit', () => {
    beforeAll(async () => {
      await ctx.app.close();
      ctx = await createTestApp();
      auth = `Bearer ${(await login(ctx)).accessToken}`;
      client = ctx.app.get(AiClient);
    });

    it('validates the request', async () => {
      jest.spyOn(client, 'configured', 'get').mockReturnValue(true);
      await post({ notes: [], count: 5 }).expect(400);
      await post({ notes, count: 50 }).expect(400);
      await post({ notes: [{ title: 'x', text: 'y'.repeat(6001) }], count: 5 }).expect(400);
      const many = Array.from({ length: 11 }, (_, i) => ({ title: `n${i}`, text: 'z'.repeat(5900) }));
      expect((await post({ notes: many, count: 5 }).expect(400)).body.code).toBe('AI_TOO_MUCH_TEXT');
    });

    it('limits generations per minute', async () => {
      jest.spyOn(client, 'configured', 'get').mockReturnValue(true);
      jest.spyOn(client, 'generateQuiz').mockResolvedValue(goodQuiz);
      const statuses: number[] = [];
      for (let i = 0; i < 8; i++) statuses.push((await post({ notes, count: 5 })).status);
      expect(statuses).toContain(429);
      expect(statuses.filter((st) => st === 200).length).toBeLessThanOrEqual(6);
    });
  });
});
