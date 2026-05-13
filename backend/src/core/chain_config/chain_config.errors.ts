import { ErrorCodes } from '../../common/errors/codes';
import { ErrorInfo } from '../../common/errors/error_info';

export const ChainConfigErrors = {
  ChainNotSupported: {
    code: ErrorCodes.CHAIN_NOT_SUPPORTED,
    httpCode: 400,
    message: 'Chain is not supported by this service',
    service: 'ChainConfig',
  },
  NoDeployedContract: {
    code: ErrorCodes.CHAIN_NO_DEPLOYED_CONTRACT,
    httpCode: 503,
    message: 'GaslessDelegate is not deployed on this chain yet',
    service: 'ChainConfig',
  },
  TokenNotFound: {
    code: ErrorCodes.CHAIN_TOKEN_NOT_FOUND,
    httpCode: 400,
    message: 'Token is not configured on this chain',
    service: 'ChainConfig',
  },
} satisfies Record<string, ErrorInfo>;
