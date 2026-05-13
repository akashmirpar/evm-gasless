import { ErrorCodes } from '../../common/errors/codes';
import { ErrorInfo } from '../../common/errors/error_info';

export const GaslessErrors = {
  InvalidRequest: {
    code: ErrorCodes.GASLESS_INVALID_REQUEST,
    httpCode: 400,
    message: 'Invalid gasless request',
    service: 'Gasless',
  },
  FeeTokenNotAcceptedAndNoRoute: {
    code: ErrorCodes.GASLESS_FEE_TOKEN_NOT_ACCEPTED_AND_NO_ROUTE,
    httpCode: 422,
    message: 'Fee token is not accepted and no swap route is available',
    service: 'Gasless',
  },
  RequestNotFound: {
    code: ErrorCodes.GASLESS_REQUEST_NOT_FOUND,
    httpCode: 404,
    message: 'Gasless transaction request not found',
    service: 'Gasless',
  },
  RequestExpired: {
    code: ErrorCodes.GASLESS_REQUEST_EXPIRED,
    httpCode: 410,
    message: 'Gasless transaction request expired (Redis TTL)',
    service: 'Gasless',
  },
  InvalidSignature: {
    code: ErrorCodes.GASLESS_INVALID_SIGNATURE,
    httpCode: 400,
    message: 'Invalid EIP-712 signature for the prepared batch',
    service: 'Gasless',
  },
  InvalidAuthorization: {
    code: ErrorCodes.GASLESS_INVALID_AUTHORIZATION,
    httpCode: 400,
    message: 'Invalid EIP-7702 authorization tuple',
    service: 'Gasless',
  },
  AlreadySubmitted: {
    code: ErrorCodes.GASLESS_REQUEST_ALREADY_SUBMITTED,
    httpCode: 409,
    message: 'Gasless transaction request was already submitted',
    service: 'Gasless',
  },
} satisfies Record<string, ErrorInfo>;
