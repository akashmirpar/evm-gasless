export enum TransactionRequestStatus {
  PENDING = 0,
  BROADCASTING = 10,
  BROADCASTED = 20,
  MINED_SUCCESS = 30,
  MINED_FAILED = 40,
  FAILED_PERMANENT = 90,
}

export const TERMINAL_STATUSES = new Set<TransactionRequestStatus>([
  TransactionRequestStatus.MINED_SUCCESS,
  TransactionRequestStatus.MINED_FAILED,
  TransactionRequestStatus.FAILED_PERMANENT,
]);
