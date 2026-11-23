/** The only parts of a Notux backup the server checks; the rest is opaque. */
export interface NotuxBackup {
  app: 'notux';
  format: 1;
  [key: string]: unknown;
}

export function isNotuxBackup(body: unknown): body is NotuxBackup {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const b = body as Record<string, unknown>;
  return b.app === 'notux' && b.format === 1;
}

/** Drive file ids are URL-safe base64-ish strings; anything else can't be one of ours. */
export function isPlausibleDriveId(id: string): boolean {
  return /^[A-Za-z0-9_-]{10,200}$/.test(id);
}

/** e.g. notux-respaldo-2026-11-23-1530.json (UTC). */
export function backupFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return `notux-respaldo-${day}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}.json`;
}
