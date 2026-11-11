/**
 * Convenience re-exports so route modules can import the whole error vocabulary
 * from a single module. The canonical definitions live in `./errors.ts`.
 */
export {
  AppError,
  badRequest as BadRequestError,
  badRequest,
  validationError,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  payloadTooLarge,
  quotaExceeded,
  type ErrorCode,
} from './errors.js';
