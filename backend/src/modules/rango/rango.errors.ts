import { ErrorCodes } from '../../common/errors/codes';
import { ErrorInfo } from '../../common/errors/error_info';

export const RangoErrors = {
  RequestFailed: {
    code: ErrorCodes.RANGO_REQUEST_FAILED,
    httpCode: 502,
    message: 'Rango API request failed',
    service: 'Rango',
  },
  NoRoute: {
    code: ErrorCodes.RANGO_NO_ROUTE,
    httpCode: 422,
    message: 'No Rango route available for the requested swap',
    service: 'Rango',
  },
  InvalidResponse: {
    code: ErrorCodes.RANGO_INVALID_RESPONSE,
    httpCode: 502,
    message: 'Rango returned an unexpected response shape',
    service: 'Rango',
  },
} satisfies Record<string, ErrorInfo>;
