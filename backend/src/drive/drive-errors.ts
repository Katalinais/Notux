import { HttpException, HttpStatus } from '@nestjs/common';
import { ApiError, ErrorCode } from '../common/api-error';
import { GoogleApiError, GoogleTokenRevokedError, isInvalidGrant } from '../google/google-errors';

// Drive 403 reasons that mean "this token can't do that" (scope missing / revoked access),
// as opposed to quota or rate limits, which are transient.
const NOT_AUTHORIZED_REASONS = new Set(['insufficientPermissions', 'authError', 'forbidden', 'appNotAuthorizedToFile']);

export function driveNotAuthorized(): ApiError {
  return new ApiError(
    HttpStatus.FORBIDDEN,
    ErrorCode.DRIVE_NOT_AUTHORIZED,
    'Google Drive access is not authorized. Sign in with Google again.',
  );
}

export function driveUnavailable(): ApiError {
  return new ApiError(HttpStatus.BAD_GATEWAY, ErrorCode.DRIVE_UNAVAILABLE, 'Google Drive is not available right now.');
}

export function backupNotFound(): ApiError {
  return new ApiError(HttpStatus.NOT_FOUND, ErrorCode.BACKUP_NOT_FOUND, 'Backup not found');
}

/** Turns anything thrown while talking to Google into the contract's HTTP errors. */
export function mapDriveError(err: unknown): HttpException {
  if (err instanceof HttpException) return err;
  if (err instanceof GoogleTokenRevokedError || isInvalidGrant(err)) return driveNotAuthorized();
  if (err instanceof GoogleApiError) {
    if (err.status === 401) return driveNotAuthorized();
    if (err.status === 403 && NOT_AUTHORIZED_REASONS.has(err.reason)) return driveNotAuthorized();
    if (err.status === 404) return backupNotFound();
  }
  return driveUnavailable();
}
