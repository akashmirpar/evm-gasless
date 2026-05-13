import { Injectable } from '@nestjs/common';
import { LessThanOrEqual, In, IsNull, Or } from 'typeorm';

import { IContext, ISystemContext } from '../../core/context/context';
import { TransactionRequestEntity } from './domain/entity/transaction_request.entity';
import { TransactionRequestStatus } from './domain/entity/status/transaction_request.status';

export interface InsertParams {
  requestId: string;
  chainId: number;
  userAddress: string;
  delegateContractAddress: string;
  feeTokenAddress: string;
  feeAmount: string;
  atomicGroupStart: number;
  batchNonce: string;
  operations: Array<{ to: string; value: string; data: string }>;
  signature: string;
  authorization: { chainId: number; address: string; nonce: string; signature: string } | null;
}

@Injectable()
export class RelayerService {
  async insertPending(ctx: IContext, params: InsertParams): Promise<TransactionRequestEntity> {
    const entity = ctx.tx.manager.create(TransactionRequestEntity, {
      ...params,
      status: TransactionRequestStatus.PENDING,
      retryTimes: 0,
      nextRetryTime: new Date(),
      txHash: null,
      broadcastRpcUrl: null,
      failureReason: null,
    });
    return ctx.tx.manager.save(entity);
  }

  async findByRequestId(ctx: IContext, requestId: string): Promise<TransactionRequestEntity | null> {
    return ctx.tx.manager.findOne(TransactionRequestEntity, { where: { requestId } });
  }

  async findActionable(ctx: ISystemContext, statuses: TransactionRequestStatus[], limit = 50): Promise<TransactionRequestEntity[]> {
    const now = new Date();
    return ctx.tx.manager.find(TransactionRequestEntity, {
      where: {
        status: In(statuses),
        nextRetryTime: Or(LessThanOrEqual(now), IsNull()),
      },
      order: { nextRetryTime: 'ASC' },
      take: limit,
    });
  }

  async setTxHash(ctx: IContext, id: string, txHash: string, rpcUrl: string): Promise<void> {
    await ctx.tx.manager.update(TransactionRequestEntity, { id }, { txHash, broadcastRpcUrl: rpcUrl });
  }

  async setFailureReason(ctx: IContext, id: string, reason: string): Promise<void> {
    await ctx.tx.manager.update(TransactionRequestEntity, { id }, { failureReason: reason });
  }

  async bumpRetry(ctx: IContext, id: string, retryTimes: number, nextRetryTime: Date): Promise<void> {
    await ctx.tx.manager.update(TransactionRequestEntity, { id }, { retryTimes, nextRetryTime });
  }
}
