import { GoogleApiError, GoogleTokenRevokedError } from '../src/google/google-errors';
import { DRIVE_FILE_SCOPE, type GoogleIdentity } from '../src/google/google-oauth.service';
import type { DriveFile, NewFileMetadata } from '../src/drive/drive.client';

/** Stands in for GoogleOAuthService: no network, deterministic identities. */
export class FakeGoogleOAuth {
  static readonly VERIFIER = 'fake-pkce-verifier';
  identity: GoogleIdentity = {
    sub: 'google-sub-1',
    email: 'estudiante@example.com',
    name: 'Ana Estudiante',
    picture: 'https://example.com/ana.png',
    refreshToken: 'google-refresh-token-1',
    scopes: ['openid', 'email', 'profile', DRIVE_FILE_SCOPE],
  };
  revoked = false;

  createPkcePair() {
    return Promise.resolve({ codeVerifier: FakeGoogleOAuth.VERIFIER, codeChallenge: 'fake-challenge' });
  }

  buildAuthUrl(state: string, codeChallenge: string): string {
    const params = new URLSearchParams({ state, code_challenge: codeChallenge });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  exchangeCode(code: string, codeVerifier: string): Promise<GoogleIdentity> {
    if (code !== 'good-google-code' || codeVerifier !== FakeGoogleOAuth.VERIFIER) {
      return Promise.reject(new Error('invalid_grant'));
    }
    return Promise.resolve(this.identity);
  }

  getAccessToken(refreshToken: string): Promise<string> {
    if (this.revoked) return Promise.reject(new GoogleTokenRevokedError());
    return Promise.resolve(`access-for-${refreshToken}`);
  }
}

/** In-memory Drive with the same surface as DriveClient. */
type StoredFile = DriveFile & { content?: Buffer };

export class FakeDriveClient {
  files = new Map<string, StoredFile>();
  failNext: GoogleApiError | null = null;
  private seq = 0;

  private check(): void {
    if (this.failNext) {
      const err = this.failNext;
      this.failNext = null;
      throw err;
    }
  }

  private newId(): string {
    return `fakeDriveFile${String(++this.seq).padStart(6, '0')}`;
  }

  listFiles(_token: string, query: { q: string; pageSize?: number }): Promise<DriveFile[]> {
    this.check();
    const all = [...this.files.values()].filter((f) => !f.trashed);
    let result: StoredFile[];
    if (query.q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
      result = all.filter((f) => f.mimeType === 'application/vnd.google-apps.folder' && f.name === 'Notux');
    } else {
      const parent = /'([^']+)' in parents/.exec(query.q)?.[1];
      result = all
        .filter((f) => f.parents?.includes(parent!) && f.appProperties?.notux === 'backup')
        .sort((a, b) => (b.createdTime ?? '').localeCompare(a.createdTime ?? ''));
    }
    return Promise.resolve(result.slice(0, query.pageSize ?? 100).map(({ content, ...meta }) => (void content, meta)));
  }

  getFile(_token: string, id: string): Promise<DriveFile> {
    this.check();
    const file = this.files.get(id);
    if (!file) return Promise.reject(new GoogleApiError(404, 'notFound', 'File not found'));
    const meta: DriveFile = { ...file };
    delete (meta as StoredFile).content;
    return Promise.resolve(meta);
  }

  createFolder(_token: string, name: string): Promise<DriveFile> {
    this.check();
    const id = this.newId();
    this.files.set(id, { id, name, mimeType: 'application/vnd.google-apps.folder', trashed: false });
    return Promise.resolve({ id, name });
  }

  uploadFile(_token: string, meta: NewFileMetadata, content: Buffer): Promise<DriveFile> {
    this.check();
    const id = this.newId();
    // Strictly increasing timestamps so "newest first" is deterministic.
    const createdTime = new Date(Date.UTC(2026, 0, 1) + this.seq * 1000).toISOString();
    const file = { id, ...meta, createdTime, size: String(content.length), trashed: false, content };
    this.files.set(id, file);
    return Promise.resolve({ id, name: meta.name, createdTime, size: file.size });
  }

  download(_token: string, id: string): Promise<Buffer> {
    this.check();
    const file = this.files.get(id);
    return file?.content ? Promise.resolve(file.content) : Promise.reject(new GoogleApiError(404, 'notFound', 'x'));
  }

  deleteFile(_token: string, id: string): Promise<void> {
    this.check();
    this.files.delete(id);
    return Promise.resolve();
  }

  backups(): DriveFile[] {
    return [...this.files.values()].filter((f) => f.appProperties?.notux === 'backup');
  }
}
