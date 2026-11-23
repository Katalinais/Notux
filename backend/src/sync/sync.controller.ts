import { Body, Controller, Get, Headers, HttpStatus, Put, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard';
import { ApiError, ErrorCode } from '../common/api-error';
import { isNotuxBackup } from '../drive/backup-validation';
import { type SyncState, SyncService } from './sync.service';

export const BASE_VERSION_HEADER = 'x-base-version';
export const VERSION_HEADER = 'x-sync-version';

class SyncStateDto implements SyncState {
  @ApiProperty({ description: '0 = nothing synced yet', example: 12 })
  version!: number;

  @ApiProperty({ type: String, nullable: true, example: '2026-11-23T20:55:00.000Z' })
  updatedAt!: string | null;

  @ApiProperty({ description: 'Uncompressed bytes', example: 122572 })
  size!: number;
}

@ApiTags('sync')
@ApiBearerAuth()
@UseGuards(AccessTokenGuard)
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get()
  @ApiOperation({ summary: 'Version of the synced data (cheap: no data).' })
  @ApiOkResponse({ type: SyncStateDto })
  state(@CurrentUserId() userId: string): Promise<SyncState> {
    return this.sync.state(userId);
  }

  @Get('data')
  @ApiOperation({ summary: 'The synced data: backup JSON as uploaded. Its version is in the X-Sync-Version header.' })
  @ApiOkResponse({ description: 'Backup JSON' })
  @ApiNoContentResponse({ description: 'Nothing synced yet' })
  async data(@CurrentUserId() userId: string, @Res() res: Response): Promise<void> {
    const snapshot = await this.sync.get(userId);
    if (!snapshot) {
      res.status(HttpStatus.NO_CONTENT).end();
      return;
    }
    res
      .status(HttpStatus.OK)
      .set({ [VERSION_HEADER]: String(snapshot.version), 'Cache-Control': 'no-store' })
      .type('application/json; charset=utf-8')
      .send(snapshot.data);
  }

  @Put('data')
  @ApiOperation({ summary: 'Replace the synced data. Fails with 409 if another device uploaded since X-Base-Version.' })
  @ApiHeader({ name: 'X-Base-Version', description: 'Version this data is based on (0 for the first upload)' })
  @ApiBody({ schema: { type: 'object', description: 'Exactly the JSON produced by createBackup() in js/backup.js' } })
  @ApiOkResponse({ type: SyncStateDto })
  @ApiConflictResponse({ description: '`{ code: "SYNC_CONFLICT" }`: fetch, decide, retry' })
  put(
    @CurrentUserId() userId: string,
    @Headers(BASE_VERSION_HEADER) base: string | undefined,
    @Body() body: unknown,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<SyncState> {
    const baseVersion = Number(base);
    if (base === undefined || !/^\d{1,9}$/.test(base) || !Number.isSafeInteger(baseVersion)) {
      throw new ApiError(
        HttpStatus.BAD_REQUEST,
        ErrorCode.INVALID_BASE_VERSION,
        'X-Base-Version must be a version number',
      );
    }
    if (!isNotuxBackup(body)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_BACKUP, 'Body is not a Notux backup');
    }
    return this.sync.put(userId, baseVersion, req.rawBody ?? Buffer.from(JSON.stringify(body)));
  }
}
