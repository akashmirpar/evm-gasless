import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';

import { startSystemTransaction } from '../../../core/context/context';
import { transitionStatus } from '../../../core/fsm/transition_status';
import { TransactionRequestEntity } from '../domain/entity/transaction_request.entity';
import { TransactionRequestAction } from '../domain/entity/status/transaction_request.action';
import { TransactionRequestStatus, TERMINAL_STATUSES } from '../domain/entity/status/transaction_request.status';
import { transactionRequestFsm } from '../fsm/transaction_request.fsm';
import { RelayerService } from '../relayer.service';
import { EvmExecutorService } from '../services/evm_executor.service';

const MAX_RETRIES = Number(process.env.RELAYER_MAX_RETRIES ?? '6');
const RETRY_BASE_MS = Number(process.env.RELAYER_RETRY_BASE_MS ?? '5000');
const RETRY_CAP_MS = Number(process.env.RELAYER_RETRY_CAP_MS ?? '300000');

@Injectable()
export class RelayerJob implements OnModuleInit {
  private readonly logger = new Logger(RelayerJob.name);
  private running = false;

  constructor(
    private readonly scheduler: SchedulerRegistry,
    private readonly relayer: RelayerService,
    private readonly executor: EvmExecutorService,
  ) {}

  onModuleInit(): void {
    const cron = process.env.RELAYER_CRON ?? '*/5 * * * * *';
    const job = new CronJob(cron, () => this.tick());
    this.scheduler.addCronJob('relayer', job as never);
    job.start();
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sysCtx = await startSystemTransaction('relayer-scan');
      let rows: TransactionRequestEntity[];
      try {
        rows = await this.relayer.findActionable(
          sysCtx,
          [TransactionRequestStatus.PENDING, TransactionRequestStatus.BROADCASTING, TransactionRequestStatus.BROADCASTED],
          50,
        );
        await sysCtx.tx.commit();
      } finally {
        await sysCtx.tx.done();
      }
      for (const row of rows) {
        await this.processOne(row);
      }
    } catch (err) {
      this.logger.error(`tick failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  private async processOne(row: TransactionRequestEntity): Promise<void> {
    if (TERMINAL_STATUSES.has(row.status)) return;

    const ctx = await startSystemTransaction(`relayer-row-${row.id.slice(0, 8)}`);
    try {
      if (row.status === TransactionRequestStatus.PENDING) {
        await transitionStatus(ctx, TransactionRequestEntity, row.id, TransactionRequestAction.START_BROADCAST, transactionRequestFsm);
        await ctx.tx.commit();
        await ctx.tx.done();
        await this.doBroadcast(row);
        return;
      }
      if (row.status === TransactionRequestStatus.BROADCASTING || row.status === TransactionRequestStatus.BROADCASTED) {
        await ctx.tx.done();
        await this.doCheckReceipt(row);
        return;
      }
    } catch (err) {
      this.logger.error(`processOne id=${row.id} failed: ${(err as Error)?.message ?? err}`);
      if (ctx.tx.hasOpenTransaction()) await ctx.tx.rollback();
      await ctx.tx.done();
      await this.recordFailure(row, err);
    }
  }

  private async doBroadcast(row: TransactionRequestEntity): Promise<void> {
    try {
      const result = await this.executor.broadcast(row);
      const ctx = await startSystemTransaction('relayer-broadcast-success');
      try {
        await this.relayer.setTxHash(ctx, row.id, result.txHash, result.rpcUrl);
        await transitionStatus(ctx, TransactionRequestEntity, row.id, TransactionRequestAction.BROADCAST_SUCCEEDED, transactionRequestFsm);
        await ctx.tx.commit();
      } finally {
        await ctx.tx.done();
      }
    } catch (err) {
      const ctx = await startSystemTransaction('relayer-broadcast-failure');
      try {
        await transitionStatus(ctx, TransactionRequestEntity, row.id, TransactionRequestAction.BROADCAST_FAILED, transactionRequestFsm);
        await ctx.tx.commit();
      } finally {
        await ctx.tx.done();
      }
      await this.recordFailure(row, err);
    }
  }

  private async doCheckReceipt(row: TransactionRequestEntity): Promise<void> {
    const receipt = await this.executor.fetchReceipt(row);
    if (receipt.status === 'pending') {
      const ctx = await startSystemTransaction('relayer-receipt-pending');
      try {
        await this.relayer.bumpRetry(ctx, row.id, row.retryTimes, new Date(Date.now() + this.backoff(row.retryTimes)));
        await ctx.tx.commit();
      } finally {
        await ctx.tx.done();
      }
      return;
    }
    const action =
      receipt.status === 'success'
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
  }

  private async recordFailure(row: TransactionRequestEntity, err: unknown): Promise<void> {
    const reason = err instanceof Error ? err.message : JSON.stringify(err);
    const ctx = await startSystemTransaction('relayer-fail-mode');
    try {
      const retryTimes = row.retryTimes + 1;
      await this.relayer.setFailureReason(ctx, row.id, reason);
      if (retryTimes >= MAX_RETRIES) {
        await transitionStatus(ctx, TransactionRequestEntity, row.id, TransactionRequestAction.GIVE_UP, transactionRequestFsm);
      } else {
        await this.relayer.bumpRetry(ctx, row.id, retryTimes, new Date(Date.now() + this.backoff(retryTimes)));
      }
      await ctx.tx.commit();
    } finally {
      await ctx.tx.done();
    }
  }

  private backoff(retries: number): number {
    return Math.min(RETRY_BASE_MS * Math.pow(2, retries), RETRY_CAP_MS);
  }
}
