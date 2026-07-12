import { ErrorCodes } from './codes';
import { ErrorInfo } from './error_info';

export const AuthErrors = {
  Unauthorized: {
    code: ErrorCodes.AUTH_UNAUTHORIZED,
    httpCode: 401,
    message: 'invalid api key',
    service: 'Auth',
  } satisfies ErrorInfo,
  Forbidden: {
    code: ErrorCodes.AUTH_FORBIDDEN,
    httpCode: 403,
    message: 'forbidden',
    service: 'Auth',
  } satisfies ErrorInfo,
  RateLimited: {
    code: ErrorCodes.AUTH_RATE_LIMITED,
    httpCode: 429,
    message: 'rate limit exceeded',
    service: 'Auth',
  } satisfies ErrorInfo,
} as const;
