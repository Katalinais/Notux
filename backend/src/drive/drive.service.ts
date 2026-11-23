import { Inject, Injectable, Logger } from '@nestjs/common';
import { decrypt } from '../common/crypto';
import { APP_CONFIG, type AppConfig } from '../config/env';
import { GoogleApiError, GoogleTokenRevokedError } from '../google/google-errors';
import { GoogleOAuthService } from '../google/google-oauth.service';
import { hasDriveAccess, REFRESH_TOKEN_AAD, UsersService } from '../users/users.service';
import { backupFileName, isPlausibleDriveId } from './backup-validation';
import { backupNotFound, driveNotAuthorized, mapDriveError } from './drive-errors';
import { DriveClient, type DriveFile, driveQuote, FOLDER_MIME } from './drive.client';

export const FOLDER_NAME = 'Notux';
export const MAX_KEPT_BACKUPS = 10;
export const MAX_LISTED_BACKUPS = 20;
const BACKUP_PROPERTY = { key: 'notux', value: 'backup' };
const BACKUP_FIELDS = 'id,name,createdTime,size';

export interface BackupInfo {
  id: string;
  name: string;
  createdTime: string;
  size: number;
}

interface DriveSession {
  userId: string;
  accessToken: string;
  folderId: string | null;
}

function toBackupInfo(file: DriveFile): BackupInfo {
  return { id: file.id, name: file.name, createdTime: file.createdTime ?? '', size: Number(file.size ?? 0) };
}

@Injectable()
export class DriveService {
  private readonly logger = new Logger(DriveService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly users: UsersService,
    private readonly google: GoogleOAuthService,
    private readonly drive: DriveClient,
  ) {}

  list(userId: string): Promise<BackupInfo[]> {
    return this.run(userId, async (s) => {
      const folderId = await this.folder(s, false);
      if (!folderId) return [];
      const files = await this.listBackups(s, folderId, MAX_LISTED_BACKUPS);
      return files.map(toBackupInfo);
    });
  }

  create(userId: string, content: Buffer, now = new Date()): Promise<BackupInfo> {
    return this.run(userId, async (s) => {
      const folderId = (await this.folder(s, true))!;
      const file = await this.drive.uploadFile(
        s.accessToken,
        {
          name: backupFileName(now),
          mimeType: 'application/json',
          parents: [folderId],
          appProperties: { [BACKUP_PROPERTY.key]: BACKUP_PROPERTY.value },
        },
        content,
        BACKUP_FIELDS,
      );
      await this.prune(s, folderId);
      return toBackupInfo(file);
    });
  }

  get(userId: string, fileId: string): Promise<Buffer> {
    return this.run(userId, async (s) => {
      await this.assertOwnBackup(s, fileId);
      return this.drive.download(s.accessToken, fileId);
    });
  }

  remove(userId: string, fileId: string): Promise<void> {
    return this.run(userId, async (s) => {
      await this.assertOwnBackup(s, fileId);
      await this.drive.deleteFile(s.accessToken, fileId);
    });
  }

  /** Opens a Drive session for the user and maps every Google failure to the contract's errors. */
  private async run<T>(userId: string, fn: (session: DriveSession) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.session(userId));
    } catch (err) {
      const mapped = mapDriveError(err);
      if (mapped.getStatus() >= 500) {
        this.logger.warn(`Drive call failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      throw mapped;
    }
  }

  private async session(userId: string): Promise<DriveSession> {
    const user = await this.users.findById(userId);
    if (!user || !hasDriveAccess(user)) throw driveNotAuthorized();

    let refreshToken: string;
    try {
      refreshToken = decrypt(user.googleRefreshTokenEnc!, this.config.tokenEncryptionKey, REFRESH_TOKEN_AAD);
    } catch {
      // Encrypted with another key (e.g. TOKEN_ENCRYPTION_KEY rotated): unusable, the user must log in again.
      await this.users.clearGoogleToken(user.id);
      throw driveNotAuthorized();
    }
    try {
      const accessToken = await this.google.getAccessToken(refreshToken);
      return { userId: user.id, accessToken, folderId: user.driveFolderId };
    } catch (err) {
      if (err instanceof GoogleTokenRevokedError) await this.users.clearGoogleToken(user.id);
      throw err;
    }
  }

  /** Returns the Notux folder id (cached per user), creating the folder when `create` is set. */
  private async folder(s: DriveSession, create: boolean): Promise<string | null> {
    if (s.folderId) {
      try {
        const folder = await this.drive.getFile(s.accessToken, s.folderId, 'id,trashed');
        if (!folder.trashed) return s.folderId;
      } catch (err) {
        if (!(err instanceof GoogleApiError && err.status === 404)) throw err;
      }
    }
    // drive.file only lets us see folders Notux itself created, so this never picks up a user's own "Notux".
    const [existing] = await this.drive.listFiles(s.accessToken, {
      q: `name = ${driveQuote(FOLDER_NAME)} and mimeType = ${driveQuote(FOLDER_MIME)} and trashed = false`,
      orderBy: 'createdTime',
      pageSize: 1,
      fields: 'id',
    });
    let folderId = existing?.id ?? null;
    if (!folderId && create) folderId = (await this.drive.createFolder(s.accessToken, FOLDER_NAME)).id;
    if (folderId !== s.folderId) {
      await this.users.setDriveFolder(s.userId, folderId);
      s.folderId = folderId;
    }
    return folderId;
  }

  private listBackups(s: DriveSession, folderId: string, pageSize: number): Promise<DriveFile[]> {
    const { key, value } = BACKUP_PROPERTY;
    return this.drive.listFiles(s.accessToken, {
      q:
        `${driveQuote(folderId)} in parents and trashed = false and ` +
        `appProperties has { key=${driveQuote(key)} and value=${driveQuote(value)} }`,
      orderBy: 'createdTime desc',
      pageSize,
      fields: BACKUP_FIELDS,
    });
  }

  /** Keeps only the newest MAX_KEPT_BACKUPS backups. A failed cleanup never fails the upload. */
  private async prune(s: DriveSession, folderId: string): Promise<void> {
    try {
      const files = await this.listBackups(s, folderId, 100);
      for (const old of files.slice(MAX_KEPT_BACKUPS)) await this.drive.deleteFile(s.accessToken, old.id);
    } catch (err) {
      this.logger.warn(`Could not prune old backups: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 404 unless the file is a live Notux backup inside the user's Notux folder. */
  private async assertOwnBackup(s: DriveSession, fileId: string): Promise<void> {
    if (!isPlausibleDriveId(fileId)) throw backupNotFound();
    const folderId = await this.folder(s, false);
    if (!folderId) throw backupNotFound();
    const file = await this.drive.getFile(s.accessToken, fileId, 'id,parents,trashed,appProperties');
    const isBackup = file.appProperties?.[BACKUP_PROPERTY.key] === BACKUP_PROPERTY.value;
    if (file.trashed || !isBackup || !file.parents?.includes(folderId)) throw backupNotFound();
  }
}
