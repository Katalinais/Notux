import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ApiError, ErrorCode } from '../common/api-error';
import { randomToken, sha256 } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';

const DAY_MS = 24 * 60 * 60 * 1000;

function invalid(): ApiError {
  return new ApiError(HttpStatus.UNAUTHORIZED, ErrorCode.INVALID_REFRESH_TOKEN, 'Invalid refresh token');
}

/**
 * Opaque refresh tokens, stored as SHA-256 hashes.
 * Every refresh rotates the token; all tokens descending from one login share a `familyId`.
 * Presenting an already-rotated (revoked) token means it leaked or was replayed, so the whole family is revoked.
 */
@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private expiry(now: Date): Date {
    return new Date(now.getTime() + this.config.refreshTokenTtlDays * DAY_MS);
  }

  async issue(userId: string, now = new Date()): Promise<string> {
    const token = randomToken(32);
    await this.prisma.refreshToken.create({
      data: { hash: sha256(token), familyId: randomUUID(), userId, expiresAt: this.expiry(now) },
    });
    return token;
  }

  async rotate(token: string, now = new Date()): Promise<{ userId: string; refreshToken: string }> {
    const current = await this.prisma.refreshToken.findUnique({ where: { hash: sha256(token) } });
    if (!current) throw invalid();
    if (current.revokedAt) {
      await this.revokeFamily(current.familyId, now);
      throw invalid();
    }
    if (current.expiresAt <= now) throw invalid();

    const next = randomToken(32);
    const rotated = await this.prisma.$transaction(async (tx) => {
      // Conditional update: if a concurrent request already rotated this token, count is 0.
      const { count } = await tx.refreshToken.updateMany({
        where: { id: current.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (count !== 1) return false;
      const created = await tx.refreshToken.create({
        data: { hash: sha256(next), familyId: current.familyId, userId: current.userId, expiresAt: this.expiry(now) },
      });
      await tx.refreshToken.update({ where: { id: current.id }, data: { replacedById: created.id } });
      return true;
    });
    if (!rotated) {
      await this.revokeFamily(current.familyId, now);
      throw invalid();
    }
    return { userId: current.userId, refreshToken: next };
  }

  /** Logout: revokes the session (the token's family). Unknown tokens are ignored. */
  async revoke(token: string, now = new Date()): Promise<void> {
    const current = await this.prisma.refreshToken.findUnique({ where: { hash: sha256(token) } });
    if (current) await this.revokeFamily(current.familyId, now);
  }

  async revokeFamily(familyId: string, now = new Date()): Promise<void> {
    await this.prisma.refreshToken.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
  }
}
