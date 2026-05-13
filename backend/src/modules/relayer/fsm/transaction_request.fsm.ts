import { StateMachine } from '../../../core/fsm/state_machine';
import { TransactionRequestAction } from '../domain/entity/status/transaction_request.action';
import { TransactionRequestStatus } from '../domain/entity/status/transaction_request.status';

export const transactionRequestFsm = new StateMachine<TransactionRequestStatus, TransactionRequestAction>([
  { from: TransactionRequestStatus.PENDING, action: TransactionRequestAction.START_BROADCAST, to: TransactionRequestStatus.BROADCASTING },
  { from: TransactionRequestStatus.BROADCASTING, action: TransactionRequestAction.BROADCAST_SUCCEEDED, to: TransactionRequestStatus.BROADCASTED },
  { from: TransactionRequestStatus.BROADCASTING, action: TransactionRequestAction.BROADCAST_FAILED, to: TransactionRequestStatus.PENDING },
  { from: TransactionRequestStatus.BROADCASTED, action: TransactionRequestAction.MARK_MINED_SUCCESS, to: TransactionRequestStatus.MINED_SUCCESS },
  { from: TransactionRequestStatus.BROADCASTED, action: TransactionRequestAction.MARK_MINED_FAILED, to: TransactionRequestStatus.MINED_FAILED },
  { from: TransactionRequestStatus.PENDING, action: TransactionRequestAction.GIVE_UP, to: TransactionRequestStatus.FAILED_PERMANENT },
  { from: TransactionRequestStatus.BROADCASTING, action: TransactionRequestAction.GIVE_UP, to: TransactionRequestStatus.FAILED_PERMANENT },
  { from: TransactionRequestStatus.BROADCASTED, action: TransactionRequestAction.GIVE_UP, to: TransactionRequestStatus.FAILED_PERMANENT },
]);
