import { In } from 'typeorm';

import { ScheduledRowProcessor, ProcessRowResult } from './scheduled_row_processor';
import { RetryPolicy } from './retry_policy';

const mockUpdate = jest.fn();
const mockCommit = jest.fn();
const mockDone = jest.fn();
const mockStartTx = jest.fn();

jest.mock('../context/context', () => ({
  startSystemTransaction: (...args: unknown[]) => mockStartTx(...args),
}));

class FakeEntity {
  id!: string;
}

interface Row {
  id: string;
  status: number;
  retryTimes: number;
  nextRetryTime: Date | null;
  updatedAt: Date | null;
  maxRetryTimes: number | null;
  baseDelayMs: number | null;
  exponentialRate: number | null;
}

function fakeRow(retryTimes = 0, overrides: Partial<Row> = {}): Row {
  return {
    id: 'row-1',
    status: 0,
    retryTimes,
    nextRetryTime: null,
    updatedAt: null,
    maxRetryTimes: null,
    baseDelayMs: null,
    exponentialRate: null,
    ...overrides,
  };
}

class TestProc extends ScheduledRowProcessor<number, Row & any> {
  readonly actionableStatuses = [0, 10];
  readonly entityClass = FakeEntity as any;
  rowToReturn!: Row;
  rowsToReturn: Row[] | null = null;
  processedIds: string[] = [];
  resultToReturn: ProcessRowResult | Error = { kind: 'done' };
  policyToReturn: RetryPolicy | Error = { maxRetryTimes: 3, baseDelayMs: 1000, exponentialRate: 2 };
  exhaustedBehaviour: 'ok' | 'throw' = 'ok';
  scheduleNextCalls: Array<{ retryTimes: number; nextRetryTime: Date }> = [];
  exhaustedCalls: Array<{ id: string; reason: string }> = [];

  resolveRetryPolicy(): RetryPolicy {
    if (this.policyToReturn instanceof Error) throw this.policyToReturn;
    return this.policyToReturn;
  }
  async processRow(row: Row): Promise<ProcessRowResult> {
    this.processedIds.push(row.id);
    if (this.resultToReturn instanceof Error) throw this.resultToReturn;
    return this.resultToReturn;
  }
  async onRetryExhausted(row: Row, reason: string): Promise<void> {
    this.exhaustedCalls.push({ id: row.id, reason });
    if (this.exhaustedBehaviour === 'throw') throw new Error('handler exploded');
  }
  protected async findDueRows(): Promise<Row[]> { return this.rowsToReturn ?? [this.rowToReturn]; }
  protected async scheduleNextAttempt(_row: Row, retryTimes: number, nextRetryTime: Date): Promise<void> {
    this.scheduleNextCalls.push({ retryTimes, nextRetryTime });
  }
  async execute(): Promise<void> { await super.execute(); }
}

/** The `{ nextRetryTime }` payload of the guarded fallback UPDATE. */
function updatePayload(call: number = 0): { nextRetryTime: Date } {
  return mockUpdate.mock.calls[call][2] as { nextRetryTime: Date };
}
function updateCriteria(call: number = 0): { id: string; status: unknown } {
  return mockUpdate.mock.calls[call][1] as { id: string; status: unknown };
}

describe('ScheduledRowProcessor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdate.mockResolvedValue({ affected: 1 });
    mockDone.mockResolvedValue(undefined);
    mockStartTx.mockResolvedValue({
      tx: { manager: { update: mockUpdate }, commit: mockCommit, done: mockDone },
    });
  });

  // A failing expectation before a test's own useRealTimers() would otherwise
  // leak fake timers into every later test in the file.
  afterEach(() => jest.useRealTimers());

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

  describe('exhaustion fallback (RIN-183)', () => {
    it('AC1 — handler throws: guarded UPDATE moves nextRetryTime into the future', async () => {
      const p = new TestProc();
      p.rowToReturn = fakeRow(0);
      p.resultToReturn = { kind: 'fail', reason: 'nope' };
      p.exhaustedBehaviour = 'throw';
      const before = Date.now();
      await p.execute();

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(updateCriteria().id).toBe('row-1');
      // The guard is the whole point: never pin a row the handler already moved.
      expect(updateCriteria().status).toEqual(In([0, 10]));
      expect(updatePayload().nextRetryTime.getTime()).toBeGreaterThan(before);
      expect(mockCommit).toHaveBeenCalled();
    });

    it('a row that exhausted its retry budget starts at the 5min cap, not the floor', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const now = Date.now();
      // Shipped defaults (base 5000ms, rate 2, max 6) leave a 320s final interval.
      const updatedAt = new Date(now - 1000);
      const p = new TestProc();
      jest.spyOn(p['logger'], 'warn').mockImplementation();
      p.rowToReturn = fakeRow(0, {
        updatedAt,
        nextRetryTime: new Date(updatedAt.getTime() + 320_000),
      });
      p.resultToReturn = { kind: 'fail', reason: 'nope' };
      await p.execute();

      expect(updatePayload().nextRetryTime.getTime() - now).toBe(300_000);
    });

    it('poison_row pins with the poison_row reason', async () => {
      const p = new TestProc();
      const pinLog = jest.spyOn(p['logger'], 'warn').mockImplementation();
      jest.spyOn(p['logger'], 'error').mockImplementation();
      p.rowToReturn = fakeRow(0);
      p.policyToReturn = { maxRetryTimes: 0, baseDelayMs: 1, exponentialRate: 2 };
      p.resultToReturn = new Error('boom');
      await p.execute();

      const pinned = pinLog.mock.calls.map(String).filter((m) => m.includes('scheduler_exhaustion_pinned'));
      expect(pinned).toHaveLength(1);
      expect(pinned[0]).toContain('poison_row:boom');
    });

    it('AC2 — handler moved the row (affected=0): silent no-op', async () => {
      mockUpdate.mockResolvedValue({ affected: 0 });
      const p = new TestProc();
      const pinLog = jest.spyOn(p['logger'], 'warn').mockImplementation();
      p.rowToReturn = fakeRow(0);
      p.resultToReturn = { kind: 'fail', reason: 'nope' };
      await p.execute();

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(pinLog.mock.calls.map(String).filter((m) => m.includes('scheduler_exhaustion_pinned'))).toHaveLength(0);
    });

    it('AC3 — handler succeeded but row still actionable: cause=handler_noop', async () => {
      const p = new TestProc();
      const pinLog = jest.spyOn(p['logger'], 'warn').mockImplementation();
      p.rowToReturn = fakeRow(0);
      p.resultToReturn = { kind: 'fail', reason: 'nope' };
      await p.execute();

      const pinned = pinLog.mock.calls.map(String).filter((m) => m.includes('scheduler_exhaustion_pinned'));
      expect(pinned).toHaveLength(1);
      expect(pinned[0]).toContain('"cause":"handler_noop"');
    });

    it('AC1 — handler threw: cause=handler_threw', async () => {
      const p = new TestProc();
      const pinLog = jest.spyOn(p['logger'], 'warn').mockImplementation();
      p.rowToReturn = fakeRow(0);
      p.resultToReturn = { kind: 'fail', reason: 'nope' };
      p.exhaustedBehaviour = 'throw';
      await p.execute();

      const pinned = pinLog.mock.calls.map(String).filter((m) => m.includes('scheduler_exhaustion_pinned'));
      expect(pinned[0]).toContain('"cause":"handler_threw"');
    });

    it('AC5 — unresolvable policy: handler NOT invoked, row backed off, retryTimes untouched', async () => {
      const p = new TestProc();
      const pinLog = jest.spyOn(p['logger'], 'warn').mockImplementation();
      jest.spyOn(p['logger'], 'error').mockImplementation();
      p.rowToReturn = fakeRow(0);
      p.policyToReturn = new Error('chain registry not hydrated');
      await p.execute();

      expect(p.exhaustedCalls).toHaveLength(0);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(updatePayload()).toEqual({ nextRetryTime: expect.any(Date) });
      const pinned = pinLog.mock.calls.map(String).filter((m) => m.includes('scheduler_exhaustion_pinned'));
      expect(pinned[0]).toContain('"cause":"unresolvable_policy"');
    });

    it('AC10 — first pin (null nextRetryTime) is exactly 30s', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const p = new TestProc();
      jest.spyOn(p['logger'], 'warn').mockImplementation();
      p.rowToReturn = fakeRow(0);
      p.resultToReturn = { kind: 'fail', reason: 'nope' };
      await p.execute();

      expect(updatePayload().nextRetryTime.getTime() - Date.now()).toBe(30_000);
      jest.useRealTimers();
    });

    it('AC4 — escalation ladder 30s → 60s → 120s → 240s → 300s (capped)', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const now = Date.now();
      const ladder = [
        { prevDelayMs: 0, expected: 30_000 },
        { prevDelayMs: 30_000, expected: 60_000 },
        { prevDelayMs: 60_000, expected: 120_000 },
        { prevDelayMs: 120_000, expected: 240_000 },
        { prevDelayMs: 240_000, expected: 300_000 },
        { prevDelayMs: 300_000, expected: 300_000 },
      ];

      for (const [i, step] of ladder.entries()) {
        const updatedAt = new Date(now - 1000);
        const p = new TestProc();
        jest.spyOn(p['logger'], 'warn').mockImplementation();
        p.rowToReturn = fakeRow(0, {
          updatedAt,
          nextRetryTime: new Date(updatedAt.getTime() + step.prevDelayMs),
        });
        p.resultToReturn = { kind: 'fail', reason: 'nope' };
        await p.execute();
        expect(updatePayload(i).nextRetryTime.getTime() - now).toBe(step.expected);
      }
      jest.useRealTimers();
    });

    it('AC9 — lateness at scan time does not change the backoff', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const now = Date.now();
      // Row scheduled with a 60s interval but scanned an hour late.
      const updatedAt = new Date(now - 3_660_000);
      const p = new TestProc();
      jest.spyOn(p['logger'], 'warn').mockImplementation();
      p.rowToReturn = fakeRow(0, {
        updatedAt,
        nextRetryTime: new Date(updatedAt.getTime() + 60_000),
      });
      p.resultToReturn = { kind: 'fail', reason: 'nope' };
      await p.execute();

      expect(updatePayload().nextRetryTime.getTime() - now).toBe(120_000);
      jest.useRealTimers();
    });

    it('AC11 — fallback never writes retryTimes, on any branch', async () => {
      const branches: Array<() => TestProc> = [
        () => { const p = new TestProc(); p.rowToReturn = fakeRow(0); p.resultToReturn = { kind: 'fail', reason: 'x' }; return p; },
        () => { const p = new TestProc(); p.rowToReturn = fakeRow(2); p.resultToReturn = { kind: 'reschedule', reason: 'x' }; return p; },
        () => { const p = new TestProc(); p.rowToReturn = fakeRow(0); p.policyToReturn = new Error('x'); return p; },
        () => { const p = new TestProc(); p.rowToReturn = fakeRow(0); p.resultToReturn = new Error('boom'); p.policyToReturn = { maxRetryTimes: 0, baseDelayMs: 1, exponentialRate: 2 }; return p; },
      ];
      for (const make of branches) {
        const p = make();
        jest.spyOn(p['logger'], 'warn').mockImplementation();
        jest.spyOn(p['logger'], 'error').mockImplementation();
        await p.execute();
      }
      expect(mockUpdate).toHaveBeenCalledTimes(branches.length);
      for (const call of mockUpdate.mock.calls) {
        expect(Object.keys(call[2] as object)).toEqual(['nextRetryTime']);
      }
    });

    it.each([
      ['startSystemTransaction rejects', () => mockStartTx.mockRejectedValue(new Error('pool exhausted'))],
      ['the UPDATE rejects', () => mockUpdate.mockRejectedValue(new Error('db down'))],
      ['done() rejects', () => mockDone.mockRejectedValue(new Error('connection already dead'))],
    ])('AC6 — %s: the rest of the batch is still processed', async (_label, arrange) => {
      arrange();
      const p = new TestProc();
      jest.spyOn(p['logger'], 'warn').mockImplementation();
      jest.spyOn(p['logger'], 'error').mockImplementation();
      p.rowsToReturn = [fakeRow(0), { ...fakeRow(0), id: 'row-2' }];
      p.resultToReturn = { kind: 'fail', reason: 'nope' };

      await expect(p.execute()).resolves.toBeUndefined();
      expect(p.processedIds).toEqual(['row-1', 'row-2']);
    });

    it('AC6 — a failing fallback UPDATE is swallowed and does not abort the tick', async () => {
      mockUpdate.mockRejectedValue(new Error('db down'));
      const p = new TestProc();
      const errLog = jest.spyOn(p['logger'], 'error').mockImplementation();
      jest.spyOn(p['logger'], 'warn').mockImplementation();
      p.rowToReturn = fakeRow(0);
      p.resultToReturn = { kind: 'fail', reason: 'nope' };

      await expect(p.execute()).resolves.toBeUndefined();
      expect(errLog.mock.calls.map(String).some((m) => m.includes('scheduler_exhaustion_backoff_failed'))).toBe(true);
      expect(mockDone).toHaveBeenCalled();
    });
  });
});
