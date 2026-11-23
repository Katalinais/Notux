import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { GoogleApiError } from '../google/google-errors';

// Minimal Google Drive v3 REST client over fetch (no `googleapis` dependency).
// Every method takes a short-lived OAuth access token; failures throw GoogleApiError.

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  createdTime?: string;
  size?: string;
  trashed?: boolean;
  parents?: string[];
  appProperties?: Record<string, string>;
}

export interface NewFileMetadata {
  name: string;
  mimeType: string;
  parents?: string[];
  appProperties?: Record<string, string>;
}

/** Quotes a value for a Drive `q` expression. */
export function driveQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

@Injectable()
export class DriveClient {
  private async request(accessToken: string, url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new GoogleApiError(0, 'network', err instanceof Error ? err.message : String(err));
    }
    if (res.ok) return res;

    let reason = 'unknown';
    let message = `Drive API responded ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
      reason = body.error?.errors?.[0]?.reason ?? reason;
      message = body.error?.message ?? message;
    } catch {
      // non-JSON error body
    }
    throw new GoogleApiError(res.status, reason, message);
  }

  private async json<T>(accessToken: string, url: string, init?: RequestInit): Promise<T> {
    return (await (await this.request(accessToken, url, init)).json()) as T;
  }

  async listFiles(
    accessToken: string,
    query: { q: string; orderBy?: string; pageSize?: number; fields?: string },
  ): Promise<DriveFile[]> {
    const params = new URLSearchParams({
      q: query.q,
      spaces: 'drive',
      pageSize: String(query.pageSize ?? 100),
      fields: `files(${query.fields ?? 'id,name,createdTime,size'})`,
    });
    if (query.orderBy) params.set('orderBy', query.orderBy);
    const body = await this.json<{ files?: DriveFile[] }>(accessToken, `${API}/files?${params.toString()}`);
    return body.files ?? [];
  }

  getFile(accessToken: string, id: string, fields: string): Promise<DriveFile> {
    return this.json<DriveFile>(
      accessToken,
      `${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`,
    );
  }

  createFolder(accessToken: string, name: string): Promise<DriveFile> {
    return this.json<DriveFile>(accessToken, `${API}/files?fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
    });
  }

  /** Multipart upload (metadata + content in one request; fine up to Drive's 5 MB guidance and beyond for JSON). */
  uploadFile(accessToken: string, metadata: NewFileMetadata, content: Buffer, fields: string): Promise<DriveFile> {
    const boundary = `notux-${randomBytes(12).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    return this.json<DriveFile>(
      accessToken,
      `${UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(fields)}`,
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
    );
  }

  async download(accessToken: string, id: string): Promise<Buffer> {
    const res = await this.request(accessToken, `${API}/files/${encodeURIComponent(id)}?alt=media`);
    return Buffer.from(await res.arrayBuffer());
  }

  async deleteFile(accessToken: string, id: string): Promise<void> {
    await this.request(accessToken, `${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}
