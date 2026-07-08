export interface OperationInput {
  to: string;
  value: string;
  data: string;
}

export interface PreparedBatch {
  ops: OperationInput[];
  atomicGroupStart: number;
  nonce: string;
}
