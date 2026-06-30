import { Injectable } from '@nestjs/common';

import { PlutonHttpException, PlutonSystemException } from '../../../common/errors/pluton_exception';
import { startSystemTransaction } from '../../../core/context/context';
import { transitionStatus } from '../../../core/fsm/transition_status';
import { ProcessRowResult, RetryPolicy, ScheduledRowProcessor, SchedulerName, SchedulerService } from '../../../core/scheduler';
import { TransactionRequestEntity } from '../domain/entity/transaction_request.entity';
import { TransactionRequestAction } from '../domain/entity/status/transaction_request.action';
import { TransactionRequestStatus, TERMINAL_STATUSES } from '../domain/entity/status/transaction_request.status';
import { transactionRequestFsm } from '../fsm/transaction_request.fsm';
import { RelayerService } from '../relayer.service';
import { EvmExecutorService } from '../services/evm_executor.service';

const DEFAULT_CRON = '*/5 * * * * *';

@Injectable()
export class RelayerJob extends ScheduledRowProcessor<
  TransactionRequestStatus,
  TransactionRequestEntity
> {
  readonly actionableStatuses: TransactionRequestStatus[] = [
    TransactionRequestStatus.PENDING,
    TransactionRequestStatus.BROADCASTING,
    TransactionRequestStatus.BROADCASTED,
  ];

  constructor(
    private readonly scheduler: SchedulerService,
    private readonly relayer: RelayerService,
    private readonly executor: EvmExecutorService,
  ) {
    super();
    const cron = process.env.RELAYER_CRON ?? DEFAULT_CRON;
    this.scheduler.register(SchedulerName.EvmRelayer, this, cron);
  }

  resolveRetryPolicy(_row: TransactionRequestEntity): RetryPolicy {
    return {
      maxRetryTimes: Number(process.env.RELAYER_MAX_RETRIES ?? '6'),
      baseDelayMs: Number(process.env.RELAYER_RETRY_BASE_MS ?? '5000'),
      exponentialRate: 2,
    };
  }

  protected async findDueRows(statuses: TransactionRequestStatus[], limit: number): Promise<TransactionRequestEntity[]> {
    const ctx = await startSystemTransaction('relayer-scan');
    try {
      const rows = await this.relayer.findActionable(ctx, statuses, limit);
      await ctx.tx.commit();
      return rows;
    } finally {
      await ctx.tx.done();
    }
  }

  protected async scheduleNextAttempt(row: TransactionRequestEntity, retryTimes: number, nextRetryTime: Date): Promise<void> {
    const ctx = await startSystemTransaction('relayer-bump');
    try {
      await this.relayer.bumpRetry(ctx, row.id, retryTimes, nextRetryTime);
      await ctx.tx.commit();
    } finally {
      await ctx.tx.done();
    }
  }

  async processRow(row: TransactionRequestEntity): Promise<ProcessRowResult> {
    if (TERMINAL_STATUSES.has(row.status)) return { kind: 'done' };

    if (row.status === TransactionRequestStatus.PENDING) {
      return this.doBroadcast(row);
    }

    if (row.status === TransactionRequestStatus.BROADCASTING) {
      return this.recoverBroadcasting(row);
    }

    if (row.status === TransactionRequestStatus.BROADCASTED) {
      return this.doCheckReceipt(row);
    }

    return { kind: 'done' };
  }

  async onRetryExhausted(row: TransactionRequestEntity, reason: string): Promise<void> {
    const ctx = await startSystemTransaction('relayer-give-up');
    try {
      await this.relayer.setFailureReason(ctx, row.id, `terminal: ${reason}`);
      await transitionStatus(ctx, TransactionRequestEntity, row.id, TransactionRequestAction.GIVE_UP, transactionRequestFsm);
      await ctx.tx.commit();
    } finally {
      await ctx.tx.done();
    }
  }

  private async doBroadcast(row: TransactionRequestEntity): Promise<ProcessRowResult> {
    const startCtx = await startSystemTransaction('relayer-broadcast-start');
    try {
      await transitionStatus(startCtx, TransactionRequestEntity, row.id, TransactionRequestAction.START_BROADCAST, transactionRequestFsm);
      await startCtx.tx.commit();
    } finally {
      await startCtx.tx.done();
    }

    try {
      const result = await this.executor.broadcast(row);
      const okCtx = await startSystemTransaction('relayer-broadcast-success');
      try {
        await this.relayer.setTxHash(okCtx, row.id, result.txHash, result.rpcUrl);
        await transitionStatus(okCtx, TransactionRequestEntity, row.id, TransactionRequestAction.BROADCAST_SUCCEEDED, transactionRequestFsm);
        await okCtx.tx.commit();
      } finally {
        await okCtx.tx.done();
      }
      return { kind: 'done' };
    } catch (err) {
      const reason = formatFailureReason(err);
      const failCtx = await startSystemTransaction('relayer-broadcast-failure');
      try {
        await this.relayer.setFailureReason(failCtx, row.id, reason);
        await transitionStatus(failCtx, TransactionRequestEntity, row.id, TransactionRequestAction.BROADCAST_FAILED, transactionRequestFsm);
        await failCtx.tx.commit();
      } finally {
        await failCtx.tx.done();
      }
      return { kind: 'reschedule', reason };
    }
  }

  private async recoverBroadcasting(row: TransactionRequestEntity): Promise<ProcessRowResult> {
    if (row.txHash) {
      const ctx = await startSystemTransaction('relayer-broadcasting-finish');
      try {
        await transitionStatus(ctx, TransactionRequestEntity, row.id, TransactionRequestAction.BROADCAST_SUCCEEDED, transactionRequestFsm);
        await ctx.tx.commit();
      } finally {
        await ctx.tx.done();
      }
      return { kind: 'done' };
    }
    const ctx = await startSystemTransaction('relayer-broadcasting-rewind');
    try {
      await this.relayer.setFailureReason(ctx, row.id, 'crash recovery: row found in BROADCASTING with no txHash');
      await transitionStatus(ctx, TransactionRequestEntity, row.id, TransactionRequestAction.BROADCAST_FAILED, transactionRequestFsm);
      await ctx.tx.commit();
    } finally {
      await ctx.tx.done();
    }
    return { kind: 'reschedule', reason: 'broadcasting_crash_recovery' };
  }

  private async doCheckReceipt(row: TransactionRequestEntity): Promise<ProcessRowResult> {
    const receipt = await this.executor.fetchReceipt(row);
    if (receipt.status === 'pending') {
      return { kind: 'wait', reason: 'tx_pending' };
    }
    const action = receipt.status === 'success'
      ? TransactionRequestAction.MARK_MINED_SUCCESS
      : TransactionRequestAction.MARK_MINED_FAILED;
    const ctx = await startSystemTransaction('relayer-receipt-final');
    try {
      if (receipt.status === 'reverted') {
        await this.relayer.setFailureReason(ctx, row.id, `tx reverted at block ${receipt.blockNumber}`);
      }
      await transitionStatus(ctx, TransactionRequestEntity, row.id, action, transactionRequestFsm);
      await ctx.tx.commit();
    } finally {
      await ctx.tx.done();
    }
    return { kind: 'done' };
  }
}

function sanitizeReason(s: string): string {
  return s
    .replace(/(https?:\/\/[^\/\s)]+)\/[a-f0-9]{32,}/gi, '$1/<redacted>')
    .replace(/([?&](?:apiKey|api_key|auth|token|key)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(\/v[23]\/)[a-f0-9]{32,}/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, '$1<redacted>');
}

function formatFailureReason(err: unknown): string {
  if (!(err instanceof Error)) return sanitizeReason(JSON.stringify(err));
  let reason = sanitizeReason(err.message);
  if (err instanceof PlutonSystemException || err instanceof PlutonHttpException) {
    const cause = err.causes[0];
    if (cause && typeof cause === 'object') {
      const serialized = JSON.stringify(cause);
      if (serialized && serialized !== '{}') {
        const safe = sanitizeReason(serialized);
        reason += ` | ${safe.length > 6000 ? safe.slice(0, 6000) + '"…[truncated]"' : safe}`;
      }
    }
  }
  return reason;
}
