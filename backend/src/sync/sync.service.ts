import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ApiError, ErrorCode } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';

export interface SyncState {
  /** 0 = nothing synced yet for this user. */
  version: number;
  updatedAt: string | null;
  /** Uncompressed size in bytes. */
  size: number;
}

export interface SyncedSnapshot extends SyncState {
  /** The backup JSON exactly as it was uploaded. */
  data: Buffer;
}

const EMPTY: SyncState = { version: 0, updatedAt: null, size: 0 };

/**
 * One snapshot per user with optimistic concurrency: an upload names the version
 * it was based on and only succeeds if that is still the latest one. Otherwise
 * another device got there first (409 SYNC_CONFLICT) and the client decides.
 */
@Injectable()
export class SyncService {
  constructor(private readonly prisma: PrismaService) {}

  async state(userId: string): Promise<SyncState> {
    const row = await this.prisma.syncedData.findUnique({
      where: { userId },
      select: { version: true, updatedAt: true, size: true },
    });
    return row ? { version: row.version, updatedAt: row.updatedAt.toISOString(), size: row.size } : EMPTY;
  }

  async get(userId: string): Promise<SyncedSnapshot | null> {
    const row = await this.prisma.syncedData.findUnique({ where: { userId } });
    if (!row) return null;
    return {
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
      size: row.size,
      data: gunzipSync(row.data),
    };
  }

  async put(userId: string, baseVersion: number, json: Buffer): Promise<SyncState> {
    const data = gzipSync(json);
    const size = json.length;
    const conflict = () =>
      new ApiError(
        HttpStatus.CONFLICT,
        ErrorCode.SYNC_CONFLICT,
        'Your data changed on another device since this one last synced',
      );

    if (baseVersion === 0) {
      try {
        const row = await this.prisma.syncedData.create({ data: { userId, version: 1, data, size } });
        return { version: row.version, updatedAt: row.updatedAt.toISOString(), size };
      } catch (err) {
        // Another device made the first upload in the meantime.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict();
        throw err;
      }
    }

    // Conditional update: only if nobody moved past baseVersion.
    const { count } = await this.prisma.syncedData.updateMany({
      where: { userId, version: baseVersion },
      data: { version: baseVersion + 1, data, size },
    });
    if (count === 0) throw conflict();
    return this.state(userId);
  }
}
