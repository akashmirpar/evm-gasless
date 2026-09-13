import { ErrorCodes } from './codes';
import { ErrorInfo } from './error_info';

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
  FeeTokenUnreadable: {
    code: ErrorCodes.GASLESS_FEE_TOKEN_UNREADABLE,
    httpCode: 400,
    message:
      'The fee-token address does not respond to a standard ERC-20 decimals() call. ' +
      'Either the address is not a contract, or the contract is not ERC-20-compliant. ' +
      'Pass either the native sentinel (0xeeee…eeee) or a valid ERC-20 fee token.',
    service: 'Gasless',
  },
  InsufficientFeeBalance: {
    code: ErrorCodes.GASLESS_INSUFFICIENT_FEE_BALANCE,
    httpCode: 422,
    message:
      'User wallet balance is below the quoted fee amount at submit time. ' +
      'This usually means the user moved tokens out of their wallet between estimate and submit, ' +
      'or the quoted fee has drifted upward (less common). Re-quote via /estimate and try again.',
    service: 'Gasless',
  },
  PriceUnavailable: {
    code: ErrorCodes.GASLESS_PRICE_UNAVAILABLE,
    httpCode: 503,
    message:
      'No fresh USD price is available for the native asset or fee token. ' +
      'The price-refresh job may be failing (Rango /meta outage) or the token is not indexed by Rango. ' +
      'Retry shortly; if it persists the operator can switch GASLESS_FEE_MODE=bps as a stopgap.',
    service: 'Gasless',
  },
  FeeBelowMaxNetworkCost: {
    code: ErrorCodes.GASLESS_FEE_BELOW_MAX_NETWORK_COST,
    httpCode: 422,
    message:
      'Refusing to quote: the computed fee is worth less than the ceiling network cost, ' +
      'so the operator could lose money if the priority-fee auction moves. ' +
      'Raise the configured profit/markup for this token, or the user should pick a different fee token.',
    service: 'Gasless',
  },
} satisfies Record<string, ErrorInfo>;
