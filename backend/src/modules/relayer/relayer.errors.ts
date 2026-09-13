import { ErrorCodes } from '../../common/errors/codes';
import { ErrorInfo } from '../../common/errors/error_info';

export const RelayerErrors = {
  BroadcastFailed: {
    code: ErrorCodes.RELAYER_BROADCAST_FAILED,
    httpCode: 502,
    message: 'Broadcasting EIP-7702 transaction failed',
    service: 'Relayer',
  },
  TxNotMined: {
    code: ErrorCodes.RELAYER_TX_NOT_MINED,
    httpCode: 504,
    message: 'Transaction not mined within wait window',
    service: 'Relayer',
  },
  TxReverted: {
    code: ErrorCodes.RELAYER_TX_REVERTED,
    httpCode: 502,
    message: 'Transaction mined with revert',
    service: 'Relayer',
  },
  GaveUp: {
    code: ErrorCodes.RELAYER_GAVE_UP,
    httpCode: 500,
    message: 'Relayer exhausted retries and gave up',
    service: 'Relayer',
  },
} satisfies Record<string, ErrorInfo>;
