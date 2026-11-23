import { Inject, Injectable } from '@nestjs/common';
import type { User } from '@prisma/client';
import { encrypt } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { DRIVE_FILE_SCOPE, type GoogleIdentity } from '../google/google-oauth.service';
import { PrismaService } from '../prisma/prisma.service';
import type { UserDto } from './user.dto';

export const REFRESH_TOKEN_AAD = 'google-refresh-token';

export function hasDriveAccess(user: Pick<User, 'googleRefreshTokenEnc' | 'googleScopes'>): boolean {
  return !!user.googleRefreshTokenEnc && user.googleScopes.split(' ').includes(DRIVE_FILE_SCOPE);
}

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    driveConnected: hasDriveAccess(user),
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  /** Creates or updates the user from a Google login. Keeps the stored refresh token when Google sends none. */
  upsertFromGoogle(identity: GoogleIdentity): Promise<User> {
    const profile = { email: identity.email, name: identity.name, picture: identity.picture };
    const tokenFields = identity.refreshToken
      ? {
          googleRefreshTokenEnc: encrypt(identity.refreshToken, this.config.tokenEncryptionKey, REFRESH_TOKEN_AAD),
          googleScopes: identity.scopes.join(' '),
        }
      : {};
    return this.prisma.user.upsert({
      where: { googleSub: identity.sub },
      create: { googleSub: identity.sub, ...profile, ...tokenFields },
      update: { ...profile, ...tokenFields },
    });
  }

  async clearGoogleToken(id: string): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { googleRefreshTokenEnc: null } });
  }

  async setDriveFolder(id: string, driveFolderId: string | null): Promise<void> {
    await this.prisma.user.update({ where: { id }, data: { driveFolderId } });
  }
}
