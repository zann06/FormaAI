export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'PDF_CONVERTER_NOT_CONFIGURED'
  | 'OCR_NOT_CONFIGURED'
  | 'JOB_CONFLICT'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 429,
  PROVIDER_ERROR: 502,
  PROVIDER_NOT_CONFIGURED: 409,
  PDF_CONVERTER_NOT_CONFIGURED: 409,
  OCR_NOT_CONFIGURED: 409,
  JOB_CONFLICT: 409,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS_BY_CODE[code] ?? 500;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError('BAD_REQUEST', message, details);
export const validationError = (message: string, details?: unknown) =>
  new AppError('VALIDATION_FAILED', message, details);
export const unauthorized = (message = 'Sign in to continue') => new AppError('UNAUTHORIZED', message);
export const forbidden = (message = 'You do not have access to this resource') => new AppError('FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError('NOT_FOUND', message);
export const conflict = (message: string, details?: unknown) => new AppError('CONFLICT', message, details);
export const payloadTooLarge = (message: string) => new AppError('PAYLOAD_TOO_LARGE', message);
export const quotaExceeded = (message: string) => new AppError('QUOTA_EXCEEDED', message);
