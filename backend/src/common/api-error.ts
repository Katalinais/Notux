import { HttpException, HttpStatus } from '@nestjs/common';

export const ErrorCode = {
  INVALID_LOGIN_CODE: 'INVALID_LOGIN_CODE',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  INVALID_REDIRECT: 'INVALID_REDIRECT',
  INVALID_BACKUP: 'INVALID_BACKUP',
  BACKUP_NOT_FOUND: 'BACKUP_NOT_FOUND',
  DRIVE_NOT_AUTHORIZED: 'DRIVE_NOT_AUTHORIZED',
  DRIVE_UNAVAILABLE: 'DRIVE_UNAVAILABLE',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const ERROR_NAMES: Partial<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  502: 'Bad Gateway',
};

/** An HttpException whose body follows the contract: `{ statusCode, message, error, code }`. */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super({ statusCode: status, message, error: ERROR_NAMES[status] ?? 'Error', code }, status);
  }
}
