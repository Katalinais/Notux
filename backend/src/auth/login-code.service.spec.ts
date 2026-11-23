import { FakePrisma } from '../testing/fake-prisma';
import { LOGIN_CODE_TTL_MS, LoginCodeService } from './login-code.service';

describe('LoginCodeService', () => {
  let prisma: FakePrisma;
  let service: LoginCodeService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new LoginCodeService(prisma.asService());
  });

  it('creates a random code stored only as a hash', async () => {
    const code = await service.create('user-1');
    expect(code.length).toBeGreaterThanOrEqual(43);
    expect(JSON.stringify(prisma.loginCode.rows)).not.toContain(code);
  });

  it('can be used exactly once', async () => {
    const code = await service.create('user-1');
    await expect(service.consume(code)).resolves.toBe('user-1');
    await expect(service.consume(code)).rejects.toMatchObject({
      status: 401,
      response: { code: 'INVALID_LOGIN_CODE' },
    });
  });

  it('expires after 60 seconds', async () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const code = await service.create('user-1', created);
    const later = new Date(created.getTime() + LOGIN_CODE_TTL_MS + 1);
    await expect(service.consume(code, later)).rejects.toMatchObject({ response: { code: 'INVALID_LOGIN_CODE' } });
  });

  it('still works just before expiry', async () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const code = await service.create('user-1', created);
    await expect(service.consume(code, new Date(created.getTime() + LOGIN_CODE_TTL_MS - 1))).resolves.toBe('user-1');
  });

  it('rejects unknown codes', async () => {
    await expect(service.consume('made-up')).rejects.toMatchObject({ status: 401 });
  });

  it('cleans up long-expired codes', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    await service.create('user-1', old);
    await service.create('user-2', new Date(old.getTime() + 2 * 60 * 60 * 1000));
    expect(prisma.loginCode.rows).toHaveLength(1);
  });
});
