import { randomBytes } from 'node:crypto';
import type { User } from '@prisma/client';
import { encrypt } from '../common/crypto';
import type { AppConfig } from '../config/env';
import { GoogleApiError, GoogleTokenRevokedError } from '../google/google-errors';
import { DRIVE_FILE_SCOPE, type GoogleOAuthService } from '../google/google-oauth.service';
import { REFRESH_TOKEN_AAD, type UsersService } from '../users/users.service';
import type { DriveClient, DriveFile } from './drive.client';
import { DriveService, MAX_KEPT_BACKUPS } from './drive.service';

const key = randomBytes(32);

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    googleSub: 'sub-1',
    username: null,
    passwordHash: null,
    email: 'estudiante@example.com',
    name: null,
    picture: null,
    googleRefreshTokenEnc: encrypt('google-refresh', key, REFRESH_TOKEN_AAD),
    googleScopes: `openid email ${DRIVE_FILE_SCOPE}`,
    driveFolderId: 'folder-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('DriveService (Google mocked)', () => {
  let user: User;
  let users: { findById: jest.Mock; clearGoogleToken: jest.Mock; setDriveFolder: jest.Mock };
  let google: { getAccessToken: jest.Mock };
  let drive: jest.Mocked<DriveClient>;
  let service: DriveService;

  beforeEach(() => {
    user = makeUser();
    users = {
      findById: jest.fn().mockImplementation(async () => user),
      clearGoogleToken: jest.fn().mockResolvedValue(undefined),
      setDriveFolder: jest.fn().mockResolvedValue(undefined),
    };
    google = { getAccessToken: jest.fn().mockResolvedValue('access-token') };
    drive = {
      listFiles: jest.fn().mockResolvedValue([]),
      getFile: jest.fn().mockImplementation(async (_t: string, id: string) => ({ id, name: 'x', trashed: false })),
      createFolder: jest.fn().mockResolvedValue({ id: 'new-folder', name: 'Notux' }),
      uploadFile: jest
        .fn()
        .mockResolvedValue({ id: 'file-new', name: 'n.json', createdTime: '2026-11-23T15:30:00Z', size: '7' }),
      download: jest.fn().mockResolvedValue(Buffer.from('{"app":"notux","format":1}')),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<DriveClient>;
    service = new DriveService(
      { tokenEncryptionKey: key } as AppConfig,
      users as unknown as UsersService,
      google as unknown as GoogleOAuthService,
      drive,
    );
  });

  it('uses the decrypted stored refresh token', async () => {
    await service.list('user-1');
    expect(google.getAccessToken).toHaveBeenCalledWith('google-refresh');
  });

  it('403 DRIVE_NOT_AUTHORIZED without a stored token or without the drive.file scope', async () => {
    user = makeUser({ googleRefreshTokenEnc: null });
    await expect(service.list('user-1')).rejects.toMatchObject({
      status: 403,
      response: { code: 'DRIVE_NOT_AUTHORIZED' },
    });
    user = makeUser({ googleScopes: 'openid email' });
    await expect(service.list('user-1')).rejects.toMatchObject({ status: 403 });
    expect(google.getAccessToken).not.toHaveBeenCalled();
  });

  it('on invalid_grant: 403 and forgets the dead token', async () => {
    google.getAccessToken.mockRejectedValueOnce(new GoogleTokenRevokedError());
    await expect(service.list('user-1')).rejects.toMatchObject({
      status: 403,
      response: { code: 'DRIVE_NOT_AUTHORIZED' },
    });
    expect(users.clearGoogleToken).toHaveBeenCalledWith('user-1');
  });

  it('on a token encrypted with another key: 403 and forgets it', async () => {
    user = makeUser({ googleRefreshTokenEnc: encrypt('x', randomBytes(32), REFRESH_TOKEN_AAD) });
    await expect(service.list('user-1')).rejects.toMatchObject({ status: 403 });
    expect(users.clearGoogleToken).toHaveBeenCalled();
  });

  it('502 DRIVE_UNAVAILABLE when Google fails', async () => {
    drive.listFiles.mockRejectedValueOnce(new GoogleApiError(500, 'backendError', 'boom'));
    await expect(service.list('user-1')).rejects.toMatchObject({
      status: 502,
      response: { code: 'DRIVE_UNAVAILABLE' },
    });
  });

  it('lists newest first, max 20, with numeric sizes', async () => {
    drive.listFiles.mockResolvedValueOnce([{ id: 'a', name: 'a.json', createdTime: 't', size: '123' }]);
    await expect(service.list('user-1')).resolves.toEqual([{ id: 'a', name: 'a.json', createdTime: 't', size: 123 }]);
    expect(drive.listFiles.mock.calls[0][1]).toMatchObject({ orderBy: 'createdTime desc', pageSize: 20 });
    expect(drive.listFiles.mock.calls[0][1].q).toContain("'folder-1' in parents");
  });

  it('returns [] and creates nothing when the user has no Notux folder yet', async () => {
    user = makeUser({ driveFolderId: null });
    await expect(service.list('user-1')).resolves.toEqual([]);
    expect(drive.createFolder).not.toHaveBeenCalled();
  });

  it('creates the Notux folder on first upload and caches its id', async () => {
    user = makeUser({ driveFolderId: null });
    const info = await service.create('user-1', Buffer.from('{}'), new Date('2026-11-23T15:30:00Z'));
    expect(drive.createFolder).toHaveBeenCalledWith('access-token', 'Notux');
    expect(users.setDriveFolder).toHaveBeenCalledWith('user-1', 'new-folder');
    expect(drive.uploadFile.mock.calls[0][1]).toMatchObject({
      name: 'notux-respaldo-2026-11-23-1530.json',
      parents: ['new-folder'],
      appProperties: { notux: 'backup' },
    });
    expect(info).toEqual({ id: 'file-new', name: 'n.json', createdTime: '2026-11-23T15:30:00Z', size: 7 });
  });

  it('recreates the folder when the cached one was deleted', async () => {
    drive.getFile.mockRejectedValueOnce(new GoogleApiError(404, 'notFound', 'gone'));
    await service.create('user-1', Buffer.from('{}'));
    expect(drive.createFolder).toHaveBeenCalled();
    expect(users.setDriveFolder).toHaveBeenCalledWith('user-1', 'new-folder');
  });

  it(`keeps only the newest ${MAX_KEPT_BACKUPS} backups after an upload`, async () => {
    const files: DriveFile[] = Array.from({ length: 13 }, (_, i) => ({ id: `f${i}`, name: `f${i}` }));
    drive.listFiles.mockResolvedValueOnce(files);
    await service.create('user-1', Buffer.from('{}'));
    expect(drive.deleteFile.mock.calls.map((c) => c[1])).toEqual(['f10', 'f11', 'f12']);
  });

  it('an upload still succeeds if pruning fails', async () => {
    drive.listFiles.mockRejectedValueOnce(new GoogleApiError(500, 'backendError', 'x'));
    await expect(service.create('user-1', Buffer.from('{}'))).resolves.toMatchObject({ id: 'file-new' });
  });

  it('downloads only Notux backups from the Notux folder', async () => {
    drive.getFile.mockImplementation(async (_t, id) =>
      id === 'folder-1'
        ? { id, name: 'Notux' }
        : { id, name: 'b', parents: ['folder-1'], appProperties: { notux: 'backup' }, trashed: false },
    );
    await expect(service.get('user-1', 'backup-file-1')).resolves.toEqual(Buffer.from('{"app":"notux","format":1}'));

    drive.getFile.mockImplementation(async (_t, id) =>
      id === 'folder-1' ? { id, name: 'Notux' } : { id, name: 'other', parents: ['somewhere-else'] },
    );
    await expect(service.get('user-1', 'foreign-file-1')).rejects.toMatchObject({ status: 404 });
    await expect(service.remove('user-1', 'foreign-file-1')).rejects.toMatchObject({ status: 404 });
    expect(drive.deleteFile).not.toHaveBeenCalled();
  });

  it('404 for ids that cannot be Drive ids, without calling Google', async () => {
    await expect(service.get('user-1', "x' or '1'='1")).rejects.toMatchObject({ status: 404 });
    expect(drive.getFile).not.toHaveBeenCalled();
  });
});
