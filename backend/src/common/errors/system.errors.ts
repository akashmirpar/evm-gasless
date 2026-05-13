import { ErrorCodes } from './codes';
import { ErrorInfo } from './error_info';

export const SystemErrors = {
  General: {
    code: ErrorCodes.SYSTEM_GENERAL,
    httpCode: 500,
    message: 'Internal server error',
    service: 'System',
  },
  ValidationError: {
    code: ErrorCodes.SYSTEM_VALIDATION_ERROR,
    httpCode: 400,
    message: 'Validation failed',
    service: 'System',
  },
  NotFound: {
    code: ErrorCodes.SYSTEM_NOT_FOUND,
    httpCode: 404,
    message: 'Resource not found',
    service: 'System',
  },
  IllegalTransition: {
    code: ErrorCodes.SYSTEM_ILLEGAL_TRANSITION,
    httpCode: 409,
    message: 'Illegal state transition',
    service: 'System',
  },
  ConcurrentTransition: {
    code: ErrorCodes.SYSTEM_CONCURRENT_TRANSITION,
    httpCode: 409,
    message: 'Concurrent state transition lost the race',
    service: 'System',
  },
} satisfies Record<string, ErrorInfo>;

export const HealthErrors = {
  CheckFailed: {
    code: ErrorCodes.HEALTH_CHECK_FAILED,
    httpCode: 503,
    message: 'Health check failed',
    service: 'Health',
  },
} satisfies Record<string, ErrorInfo>;
