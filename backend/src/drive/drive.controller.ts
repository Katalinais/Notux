import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { AccessTokenGuard, CurrentUserId } from '../auth/access-token.guard';
import { ApiError, ErrorCode } from '../common/api-error';
import { isNotuxBackup } from './backup-validation';
import { type BackupInfo, DriveService } from './drive.service';

class BackupInfoDto implements BackupInfo {
  @ApiProperty({ example: '1AbCdEfGhIjKlMnOpQrStUvWxYz' })
  id!: string;

  @ApiProperty({ example: 'notux-respaldo-2026-11-23-1530.json' })
  name!: string;

  @ApiProperty({ example: '2026-11-23T15:30:00.000Z' })
  createdTime!: string;

  @ApiProperty({ description: 'Bytes', example: 52344 })
  size!: number;
}

const BACKUP_BODY_SCHEMA = {
  type: 'object',
  required: ['app', 'format'],
  properties: { app: { type: 'string', enum: ['notux'] }, format: { type: 'number', enum: [1] } },
  additionalProperties: true,
  description: 'Exactly the JSON produced by createBackup() in js/backup.js (max 25 MB).',
};

@ApiTags('drive')
@ApiBearerAuth()
@ApiForbiddenResponse({ description: '`{ code: "DRIVE_NOT_AUTHORIZED" }`: log in with Google again' })
@ApiBadGatewayResponse({ description: '`{ code: "DRIVE_UNAVAILABLE" }`' })
@UseGuards(AccessTokenGuard)
@Controller('drive/backups')
export class DriveController {
  constructor(private readonly drive: DriveService) {}

  @Get()
  @ApiOperation({ summary: 'Backups in the Notux Drive folder, newest first (max 20).' })
  @ApiOkResponse({ type: [BackupInfoDto] })
  list(@CurrentUserId() userId: string): Promise<BackupInfo[]> {
    return this.drive.list(userId);
  }

  @Post()
  @ApiOperation({ summary: 'Upload a backup. Keeps only the newest 10.' })
  @ApiBody({ schema: BACKUP_BODY_SCHEMA })
  @ApiCreatedResponse({ type: BackupInfoDto })
  create(
    @CurrentUserId() userId: string,
    @Body() body: unknown,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<BackupInfo> {
    if (!isNotuxBackup(body)) {
      throw new ApiError(HttpStatus.BAD_REQUEST, ErrorCode.INVALID_BACKUP, 'Body is not a Notux backup');
    }
    // Store the exact bytes the client sent, so GET returns the backup unchanged.
    return this.drive.create(userId, req.rawBody ?? Buffer.from(JSON.stringify(body)));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Download a backup (the JSON exactly as uploaded).' })
  @ApiOkResponse({ schema: BACKUP_BODY_SCHEMA })
  @ApiNotFoundResponse({ description: 'Not found or not a Notux backup' })
  async get(@CurrentUserId() userId: string, @Param('id') id: string): Promise<StreamableFile> {
    const content = await this.drive.get(userId, id);
    return new StreamableFile(content, { type: 'application/json; charset=utf-8', length: content.length });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a backup.' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Not found or not a Notux backup' })
  async remove(@CurrentUserId() userId: string, @Param('id') id: string): Promise<void> {
    await this.drive.remove(userId, id);
  }
}
