import { Check, Column, Entity, Index } from 'typeorm';

import { BaseStatefulEntity } from '../../../../common/base-stateful.entity';
import { chainIdTransformer } from '../../../../common/utils/chain_id.transformer';
import { TransactionRequestStatus } from './status/transaction_request.status';

export interface StoredOperation {
  to: string;
  value: string;
  data: string;
}

export interface StoredAuthorization {
  chainId: number;
  address: string;
  nonce: string;
  signature: string;
}

@Entity({ name: 'transaction_request' })
@Index(['chainId', 'userAddress'])
@Check(`status IN (0, 10, 20, 30, 40, 90)`)
export class TransactionRequestEntity extends BaseStatefulEntity<TransactionRequestStatus> {
  @Column({ name: 'request_id', type: 'varchar', unique: true })
  requestId!: string;

  @Column({ name: 'chain_id', type: 'bigint', transformer: chainIdTransformer })
  chainId!: number;

  @Column({ name: 'user_address' })
  userAddress!: string;

  @Column({ name: 'delegate_contract_address' })
  delegateContractAddress!: string;

  @Column({ name: 'fee_token_address' })
  feeTokenAddress!: string;

  @Column({ name: 'fee_amount', type: 'numeric', precision: 78, scale: 0 })
  feeAmount!: string;

  @Column({ name: 'atomic_group_start', type: 'integer' })
  atomicGroupStart!: number;

  @Column({ name: 'batch_nonce', type: 'numeric', precision: 78, scale: 0 })
  batchNonce!: string;

  @Column({ type: 'jsonb' })
  operations!: StoredOperation[];

  @Column({ type: 'varchar' })
  signature!: string;

  @Column({ type: 'jsonb', nullable: true })
  authorization!: StoredAuthorization | null;

  @Column({ name: 'tx_hash', type: 'varchar', nullable: true })
  txHash!: string | null;

  @Column({ name: 'broadcast_rpc_url', type: 'varchar', nullable: true })
  broadcastRpcUrl!: string | null;

  @Column({ name: 'failure_reason', type: 'text', nullable: true })
  failureReason!: string | null;
}
