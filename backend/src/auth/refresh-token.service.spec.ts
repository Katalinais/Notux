import type { AppConfig } from '../config/env';
import { sha256 } from '../common/crypto';
import { FakePrisma } from '../testing/fake-prisma';
import { RefreshTokenService } from './refresh-token.service';

const DAY = 24 * 60 * 60 * 1000;

describe('RefreshTokenService', () => {
  let prisma: FakePrisma;
  let service: RefreshTokenService;

  beforeEach(() => {
    prisma = new FakePrisma();
    service = new RefreshTokenService(prisma.asService(), { refreshTokenTtlDays: 30 } as AppConfig);
  });

  const rowFor = (token: string) => prisma.refreshToken.rows.find((r) => r.hash === sha256(token))!;

  it('stores only the hash, with a 30 day expiry', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const token = await service.issue('user-1', now);
    const row = rowFor(token);
    expect(row).toBeDefined();
    expect(JSON.stringify(prisma.refreshToken.rows)).not.toContain(token);
    expect((row.expiresAt as Date).getTime()).toBe(now.getTime() + 30 * DAY);
  });

  it('rotates: the old token is revoked and linked to its replacement in the same family', async () => {
    const first = await service.issue('user-1');
    const { userId, refreshToken: second } = await service.rotate(first);

    expect(userId).toBe('user-1');
    expect(second).not.toBe(first);
    const old = rowFor(first);
    const next = rowFor(second);
    expect(old.revokedAt).toBeInstanceOf(Date);
    expect(old.replacedById).toBe(next.id);
    expect(next.familyId).toBe(old.familyId);
    expect(next.revokedAt).toBeNull();

    // The new one keeps working.
    await expect(service.rotate(second)).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('detects reuse of a rotated token and revokes the whole family', async () => {
    const first = await service.issue('user-1');
    const { refreshToken: second } = await service.rotate(first);

    await expect(service.rotate(first)).rejects.toMatchObject({
      status: 401,
      response: { code: 'INVALID_REFRESH_TOKEN' },
    });
    // The legitimate-looking newer token is now dead too.
    expect(rowFor(second).revokedAt).toBeInstanceOf(Date);
    await expect(service.rotate(second)).rejects.toMatchObject({ status: 401 });
  });

  it('does not touch other families on reuse', async () => {
    const a = await service.issue('user-1');
    const b = await service.issue('user-1');
    await service.rotate(a);
    await expect(service.rotate(a)).rejects.toMatchObject({ status: 401 });
    await expect(service.rotate(b)).resolves.toMatchObject({ userId: 'user-1' });
  });

  it('rejects unknown and expired tokens', async () => {
    await expect(service.rotate('does-not-exist')).rejects.toMatchObject({
      response: { code: 'INVALID_REFRESH_TOKEN' },
    });
    const now = new Date('2026-01-01T00:00:00Z');
    const token = await service.issue('user-1', now);
    await expect(service.rotate(token, new Date(now.getTime() + 31 * DAY))).rejects.toMatchObject({ status: 401 });
  });

  it('treats a lost race (token rotated concurrently) as reuse', async () => {
    const token = await service.issue('user-1');
    const original = prisma.refreshToken.updateMany.bind(prisma.refreshToken);
    // Simulate another request revoking the row between our read and our conditional update.
    jest.spyOn(prisma.refreshToken, 'updateMany').mockImplementationOnce(async (args) => {
      rowFor(token).revokedAt = new Date();
      return original(args);
    });
    await expect(service.rotate(token)).rejects.toMatchObject({ status: 401 });
    expect(prisma.refreshToken.rows).toHaveLength(1);
  });

  it('logout revokes the family and is idempotent', async () => {
    const first = await service.issue('user-1');
    const { refreshToken: second } = await service.rotate(first);
    await service.revoke(second);
    await service.revoke(second);
    await service.revoke('unknown-token');
    await expect(service.rotate(second)).rejects.toMatchObject({ status: 401 });
  });
});
