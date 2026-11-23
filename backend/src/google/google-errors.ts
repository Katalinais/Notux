/** Google said the stored refresh token is no longer valid (revoked, expired, password change...). */
export class GoogleTokenRevokedError extends Error {
  constructor(message = 'Google refresh token is no longer valid') {
    super(message);
    this.name = 'GoogleTokenRevokedError';
  }
}

/** A non-2xx answer (or network failure, status 0) from a Google API. */
export class GoogleApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** True when a google-auth-library / gaxios error carries OAuth's `invalid_grant`. */
export function isInvalidGrant(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { message?: unknown; response?: { data?: { error?: unknown } } };
  if (e.response?.data?.error === 'invalid_grant') return true;
  return typeof e.message === 'string' && e.message.includes('invalid_grant');
}
