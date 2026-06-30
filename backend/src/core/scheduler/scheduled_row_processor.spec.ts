import { ScheduledRowProcessor, ProcessRowResult } from './scheduled_row_processor';
import { RetryPolicy } from './retry_policy';

interface Row {
  id: string;
  status: number;
  retryTimes: number;
  nextRetryTime: Date | null;
  maxRetryTimes: number | null;
  baseDelayMs: number | null;
  exponentialRate: number | null;
}

function fakeRow(retryTimes = 0): Row {
  return { id: 'row-1', status: 0, retryTimes, nextRetryTime: null, maxRetryTimes: null, baseDelayMs: null, exponentialRate: null };
}

class TestProc extends ScheduledRowProcessor<number, Row & any> {
  readonly actionableStatuses = [0];
  rowToReturn!: Row;
  resultToReturn: ProcessRowResult | Error = { kind: 'done' };
  scheduleNextCalls: Array<{ retryTimes: number; nextRetryTime: Date }> = [];
  exhaustedCalls: Array<{ id: string; reason: string }> = [];
  resolveRetryPolicy(): RetryPolicy { return { maxRetryTimes: 3, baseDelayMs: 1000, exponentialRate: 2 }; }
  async processRow(): Promise<ProcessRowResult> {
    if (this.resultToReturn instanceof Error) throw this.resultToReturn;
    return this.resultToReturn;
  }
  async onRetryExhausted(row: Row, reason: string): Promise<void> {
    this.exhaustedCalls.push({ id: row.id, reason });
  }
  protected async findDueRows(): Promise<Row[]> { return [this.rowToReturn]; }
  protected async scheduleNextAttempt(_row: Row, retryTimes: number, nextRetryTime: Date): Promise<void> {
    this.scheduleNextCalls.push({ retryTimes, nextRetryTime });
  }
  async execute(): Promise<void> { await super.execute(); }
}

describe('ScheduledRowProcessor', () => {
  it('"done" — no schedule, no exhaust', async () => {
    const p = new TestProc();
    p.rowToReturn = fakeRow();
    p.resultToReturn = { kind: 'done' };
    await p.execute();
    expect(p.scheduleNextCalls).toHaveLength(0);
    expect(p.exhaustedCalls).toHaveLength(0);
  });

  it('"wait" — schedules next attempt with retryTimes UNCHANGED', async () => {
    const p = new TestProc();
    p.rowToReturn = fakeRow(2);
    p.resultToReturn = { kind: 'wait', reason: 'r' };
    await p.execute();
    expect(p.scheduleNextCalls).toHaveLength(1);
    expect(p.scheduleNextCalls[0].retryTimes).toBe(2);
    expect(p.exhaustedCalls).toHaveLength(0);
  });

  it('"reschedule" — bumps retryTimes by 1', async () => {
    const p = new TestProc();
    p.rowToReturn = fakeRow(0);
    p.resultToReturn = { kind: 'reschedule', reason: 'r' };
    await p.execute();
    expect(p.scheduleNextCalls).toHaveLength(1);
    expect(p.scheduleNextCalls[0].retryTimes).toBe(1);
  });

  it('"reschedule" at last attempt calls onRetryExhausted instead of scheduleNext', async () => {
    const p = new TestProc();
    p.rowToReturn = fakeRow(2);
    p.resultToReturn = { kind: 'reschedule', reason: 'r' };
    await p.execute();
    expect(p.exhaustedCalls).toHaveLength(1);
    expect(p.scheduleNextCalls).toHaveLength(0);
  });

  it('"fail" — escalates immediately regardless of retryTimes', async () => {
    const p = new TestProc();
    p.rowToReturn = fakeRow(0);
    p.resultToReturn = { kind: 'fail', reason: 'terminal' };
    await p.execute();
    expect(p.exhaustedCalls).toHaveLength(1);
    expect(p.exhaustedCalls[0].reason).toContain('terminal');
    expect(p.scheduleNextCalls).toHaveLength(0);
  });

  it('uncaught processRow throw — schedules wait (no budget), 1st time', async () => {
    const p = new TestProc();
    p.rowToReturn = fakeRow(0);
    p.resultToReturn = new Error('boom');
    await p.execute();
    expect(p.scheduleNextCalls).toHaveLength(1);
    expect(p.scheduleNextCalls[0].retryTimes).toBe(0);
  });
});
