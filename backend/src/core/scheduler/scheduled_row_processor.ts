import { Injectable, Logger } from '@nestjs/common';

import { BaseStatefulEntity } from '../../common/base-stateful.entity';

import { BaseJob } from './base.job';
import { RetryPolicy, computeNextRetryAt, isRetryExhausted } from './retry_policy';

export type ProcessRowResult =
  | { kind: 'done' }
  | { kind: 'reschedule'; reason: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'fail'; reason: string };

@Injectable()
export abstract class ScheduledRowProcessor<
  S extends number,
  E extends BaseStatefulEntity<S>,
> extends BaseJob {
  protected readonly batchSize: number = 50;
  private running = false;
  protected readonly logger = new Logger(this.constructor.name);

  abstract readonly actionableStatuses: S[];

  abstract resolveRetryPolicy(row: E): RetryPolicy;
  abstract processRow(row: E): Promise<ProcessRowResult>;
  abstract onRetryExhausted(row: E, reason: string): Promise<void>;

  protected abstract findDueRows(statuses: S[], limit: number): Promise<E[]>;
  protected abstract scheduleNextAttempt(row: E, retryTimes: number, nextRetryTime: Date): Promise<void>;

  protected effectiveRetryPolicy(row: E): RetryPolicy {
    if (
      row.maxRetryTimes !== null &&
      row.baseDelayMs !== null &&
      row.exponentialRate !== null
    ) {
      return {
        maxRetryTimes: row.maxRetryTimes,
        baseDelayMs: row.baseDelayMs,
        exponentialRate: row.exponentialRate,
      };
    }
    return this.resolveRetryPolicy(row);
  }

  async execute(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.findDueRows(this.actionableStatuses, this.batchSize);
      for (const row of rows) {
        await this.processWithRetry(row);
      }
    } catch (err) {
      this.logger.error(`tick failed: ${(err as Error)?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  private readonly poisonThrowCounter = new Map<string, number>();

  private async processWithRetry(row: E): Promise<void> {
    let policy: RetryPolicy;
    try {
      policy = this.effectiveRetryPolicy(row);
    } catch (err) {
      this.logger.error(`effectiveRetryPolicy failed id=${row.id} err=${(err as Error)?.message ?? err}`);
      await this.safeOnExhausted(row, 'unresolvable_policy');
      return;
    }

    let result: ProcessRowResult;
    try {
      result = await this.processRow(row);
      this.poisonThrowCounter.delete(row.id);
    } catch (err) {
      const consecutive = (this.poisonThrowCounter.get(row.id) ?? 0) + 1;
      this.poisonThrowCounter.set(row.id, consecutive);
      const maxConsecutive = policy.maxRetryTimes + 1;
      if (consecutive >= maxConsecutive) {
        this.logger.error(`processRow threw ${consecutive} times in a row (cap ${maxConsecutive}) — escalating to exhaustion id=${row.id} err=${(err as Error)?.message ?? err}`);
        this.poisonThrowCounter.delete(row.id);
        await this.safeOnExhausted(row, `poison_row:${(err as Error)?.message ?? 'unknown'}`);
        return;
      }
      this.logger.warn(`processRow threw (${consecutive}/${maxConsecutive}) — waiting id=${row.id} err=${(err as Error)?.message ?? err}`);
      await this.scheduleWait(row, policy);
      return;
    }

    if (result.kind === 'done') return;
    if (result.kind === 'fail') {
      await this.safeOnExhausted(row, result.reason);
      return;
    }
    if (result.kind === 'wait') {
      await this.scheduleWait(row, policy);
      return;
    }
    await this.scheduleRetry(row, policy, result.reason);
  }

  protected async scheduleWait(row: E, policy: RetryPolicy): Promise<void> {
    await this.scheduleNextAttempt(row, row.retryTimes, new Date(Date.now() + policy.baseDelayMs));
  }

  protected async scheduleRetry(row: E, policy: RetryPolicy, reason: string): Promise<void> {
    const nextRetryTimes = row.retryTimes + 1;
    if (isRetryExhausted(policy, nextRetryTimes)) {
      this.logger.warn(`retry exhausted id=${row.id} reason=${reason} retryTimes=${nextRetryTimes} max=${policy.maxRetryTimes}`);
      await this.safeOnExhausted(row, `retry_exhausted:${reason}`);
      return;
    }
    await this.scheduleNextAttempt(row, nextRetryTimes, computeNextRetryAt(policy, nextRetryTimes, new Date()));
  }

  private async safeOnExhausted(row: E, reason: string): Promise<void> {
    try {
      await this.onRetryExhausted(row, reason);
    } catch (err) {
      this.logger.error(`onRetryExhausted failed id=${row.id} reason=${reason} err=${(err as Error)?.message ?? err}`);
    }
  }
}
