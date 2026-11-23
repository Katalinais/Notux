import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError, ErrorCode } from '../common/api-error';
import { randomToken, sha256 } from '../common/crypto';
import { PrismaService } from '../prisma/prisma.service';

export const LOGIN_CODE_TTL_MS = 60 * 1000;

/** One-time codes handed to the frontend in the post-login redirect and swapped for tokens via /auth/exchange. */
@Injectable()
export class LoginCodeService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, now = new Date()): Promise<string> {
    const code = randomToken(32);
    await this.prisma.loginCode.create({
      data: { hash: sha256(code), userId, expiresAt: new Date(now.getTime() + LOGIN_CODE_TTL_MS) },
    });
    // Housekeeping: codes are useless a minute after creation.
    await this.prisma.loginCode.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - 60 * 60 * 1000) } } });
    return code;
  }

  /** Marks the code as used and returns its user id. Single use, atomic, expires after 60 s. */
  async consume(code: string, now = new Date()): Promise<string> {
    const hash = sha256(code);
    const { count } = await this.prisma.loginCode.updateMany({
      where: { hash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    const record = count === 1 ? await this.prisma.loginCode.findUnique({ where: { hash } }) : null;
    if (!record) {
      throw new ApiError(HttpStatus.UNAUTHORIZED, ErrorCode.INVALID_LOGIN_CODE, 'Invalid or expired login code');
    }
    return record.userId;
  }
}
