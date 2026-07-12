import { ErrorCodes } from './codes';
import { ErrorInfo } from './error_info';

export const AdminErrors = {
  ApiKeyNotFound: {
    code: ErrorCodes.ADMIN_API_KEY_NOT_FOUND,
    httpCode: 404,
    message: 'api key not found',
    service: 'Admin',
  } satisfies ErrorInfo,
  CannotDeactivateLastAdmin: {
    code: ErrorCodes.ADMIN_CANNOT_DEACTIVATE_LAST_ADMIN,
    httpCode: 409,
    message: 'cannot deactivate the last active admin',
    service: 'Admin',
  } satisfies ErrorInfo,
  KeyAlreadyExists: {
    code: ErrorCodes.ADMIN_KEY_ALREADY_EXISTS,
    httpCode: 409,
    message: 'key generation collision — retry',
    service: 'Admin',
  } satisfies ErrorInfo,
  AdminNotFound: {
    code: ErrorCodes.ADMIN_NOT_FOUND,
    httpCode: 404,
    message: 'admin not found',
    service: 'Admin',
  } satisfies ErrorInfo,
  AdminNameTaken: {
    code: ErrorCodes.ADMIN_NAME_TAKEN,
    httpCode: 409,
    message: 'admin name already in use',
    service: 'Admin',
  } satisfies ErrorInfo,
} as const;
