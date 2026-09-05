import { Injectable, Logger } from '@nestjs/common';
import { FindOptionsWhere, In } from 'typeorm';
import { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

import { BaseStatefulEntity } from '../../common/base-stateful.entity';
import { ISystemContext, startSystemTransaction } from '../context/context';

import { BaseJob } from './base.job';
import { RetryPolicy, computeNextRetryAt, isRetryExhausted } from './retry_policy';

export type ProcessRowResult =
  | { kind: 'done' }
  | { kind: 'reschedule'; reason: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'fail'; reason: string };

/** Why a row was still actionable after the exhaustion path ran. */
export type ExhaustionPinCause = 'handler_threw' | 'handler_noop' | 'unresolvable_policy';

/** Bounds for the exhaustion-fallback backoff. See docs/state-machine-and-scheduler.md. */
const EXHAUSTION_MIN_DELAY_MS = 30_000;
const EXHAUSTION_MAX_DELAY_MS = 5 * 60 * 1000;

@Injectable()
export abstract class ScheduledRowProcessor<
  S extends number,
  E extends BaseStatefulEntity<S>,
> extends BaseJob {
  protected readonly batchSize: number = 50;
  private running = false;
  protected readonly logger = new Logger(this.constructor.name);

  abstract readonly actionableStatuses: S[];
  abstract readonly entityClass: { new (): E; name: string };

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
      // Infrastructure fault, not a verdict on the row: onRetryExhausted is
      // GIVE_UP in both jobs and would terminally fail a healthy row.
      await this.applyExhaustionBackoff(row, 'unresolvable_policy', 'unresolvable_policy');
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
        await this.runExhaustion(row, `poison_row:${(err as Error)?.message ?? 'unknown'}`);
        return;
      }
      this.logger.warn(`processRow threw (${consecutive}/${maxConsecutive}) — waiting id=${row.id} err=${(err as Error)?.message ?? err}`);
      await this.scheduleWait(row, policy);
      return;
    }

    if (result.kind === 'done') return;
    if (result.kind === 'fail') {
      await this.runExhaustion(row, result.reason);
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
      await this.runExhaustion(row, `retry_exhausted:${reason}`);
      return;
    }
    await this.scheduleNextAttempt(row, nextRetryTimes, computeNextRetryAt(policy, nextRetryTimes, new Date()));
  }

  private async runExhaustion(row: E, reason: string): Promise<void> {
    const handled = await this.safeOnExhausted(row, reason);
    await this.applyExhaustionBackoff(row, reason, handled ? 'handler_noop' : 'handler_threw');
  }

  private async safeOnExhausted(row: E, reason: string): Promise<boolean> {
    try {
      await this.onRetryExhausted(row, reason);
      return true;
    } catch (err) {
      this.logger.error(`onRetryExhausted failed id=${row.id} reason=${reason} err=${(err as Error)?.message ?? err}`);
      return false;
    }
  }

  /** See docs/state-machine-and-scheduler.md §2.8 for the scheme and its bounds. */
  private async applyExhaustionBackoff(row: E, reason: string, cause: ExhaustionPinCause): Promise<void> {
    // Never writes `retryTimes`: it is the shared budget read by
    // `isRetryExhausted`, so bumping it would let a transient handler failure
    // terminally fail a healthy row.
    const entity = this.entityClass.name;
    const previousDelayMs =
      row.nextRetryTime && row.updatedAt
        ? Math.max(0, row.nextRetryTime.getTime() - row.updatedAt.getTime())
        : 0;
    const proposedMs = 2 * previousDelayMs;
    const backoffMs = Number.isFinite(proposedMs)
      ? Math.min(Math.max(proposedMs, EXHAUSTION_MIN_DELAY_MS), EXHAUSTION_MAX_DELAY_MS)
      : EXHAUSTION_MIN_DELAY_MS;
    const nextRetryTime = new Date(Date.now() + backoffMs);

    // A pinned row is the oldest and heads every batch, so nothing here may
    // escape: acquiring the transaction, the UPDATE, and releasing it can all
    // throw (pool exhaustion, failover), and an escape would drop every
    // remaining row in the tick.
    // `satisfies` keeps both field names compile-checked: renaming either would
    // otherwise degrade the guard into an unguarded UPDATE, or the SET clause
    // into a silent no-op, only at runtime.
    const criteria = {
      id: row.id,
      status: In(this.actionableStatuses),
    } satisfies Record<Extract<keyof BaseStatefulEntity<S>, 'id' | 'status'>, unknown>;
    // TypeORM appends `updated_at` to this UPDATE; the ladder above reads it as
    // the pin clock, so a raw query here would flatten escalation to the floor.
    const payload: QueryDeepPartialEntity<BaseStatefulEntity<S>> = { nextRetryTime };

    let affected = 0;
    let ctx: ISystemContext | undefined;
    try {
      ctx = await startSystemTransaction('scheduler-exhaustion-backoff');
      const result = await ctx.tx.manager.update(
        this.entityClass,
        criteria as FindOptionsWhere<E>,
        payload as QueryDeepPartialEntity<E>,
      );
      await ctx.tx.commit();
      affected = result.affected ?? 0;
    } catch (err) {
      this.logger.error(`scheduler_exhaustion_backoff_failed ${JSON.stringify({ entity, id: row.id, reason, cause })} err=${(err as Error)?.message ?? err}`);
      return;
    } finally {
      await ctx?.tx.done().catch((err: unknown) => {
        this.logger.error(`scheduler_exhaustion_backoff_release_failed ${JSON.stringify({ entity, id: row.id })} err=${(err as Error)?.message ?? err}`);
      });
    }

    if (affected === 0) return;

    this.logger.warn(`scheduler_exhaustion_pinned ${JSON.stringify({ entity, id: row.id, reason, cause, nextRetryTime: nextRetryTime.toISOString(), backoffMs })}`);
  }
}
