import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { In } from 'typeorm';

/**
 * RIN-183 regression: a row whose `onRetryExhausted` throws must not be
 * re-selected on the following ticks. Before the fallback, the exhaustion branch
 * wrote nothing, so `findActionable` re-selected the row every tick forever.
 *
 * Runs against a real Postgres because the fallback's value is entirely in the
 * SQL it emits: a guarded `WHERE id = ? AND status IN (...)` UPDATE. A mocked
 * manager would pass even if that criteria were invalid. The scan runs the real
 * `RelayerService.findActionable`, so the pin is proven against the query the
 * relayer actually issues rather than a copy of it.
 */
describe('scheduler exhaustion fallback against a real Postgres', () => {
  let postgres: StartedTestContainer;
  let AppDataSource: import('typeorm').DataSource;
  let TransactionRequestEntity: any;
  let TransactionRequestStatus: any;
  let ScheduledRowProcessor: any;
  let startSystemTransaction: any;
  let relayer: any;

  beforeAll(async () => {
    postgres = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({ POSTGRES_USER: 'gasless', POSTGRES_PASSWORD: 'gasless', POSTGRES_DB: 'gasless' })
      .withExposedPorts(5432)
      .withCommand(['postgres', '-c', 'fsync=off'])
      .start();

    // buildDataSourceOptions() runs at import time, so the target must be in the
    // environment before the module is loaded.
    process.env.DATABASE_POSTGRES_HOST = postgres.getHost();
    process.env.DATABASE_POSTGRES_PORT = String(postgres.getMappedPort(5432));
    process.env.DATABASE_POSTGRES_USERNAME = 'gasless';
    process.env.DATABASE_POSTGRES_PASSWORD = 'gasless';
    process.env.DATABASE_POSTGRES_DATABASE = 'gasless';

    ({ AppDataSource } = await import('src/core/database/data-source'));
    ({ TransactionRequestEntity } = await import('src/modules/relayer/domain/entity/transaction_request.entity'));
    ({ TransactionRequestStatus } = await import('src/modules/relayer/domain/entity/status/transaction_request.status'));
    ({ ScheduledRowProcessor } = await import('src/core/scheduler/scheduled_row_processor'));
    ({ startSystemTransaction } = await import('src/core/context/context'));
    const { RelayerService } = await import('src/modules/relayer/relayer.service');
    // The real scan query; only the config lookups it makes are stubbed.
    relayer = new RelayerService({ get: () => undefined } as never);

    await AppDataSource.initialize();
    // Guard against the singleton having resolved to a developer's real database
    // via dotenv before this file set the container's coordinates.
    expect(AppDataSource.options).toMatchObject({ port: postgres.getMappedPort(5432) });
  }, 300_000);

  afterAll(async () => {
    if (AppDataSource?.isInitialized) await AppDataSource.destroy();
    await postgres?.stop();
  });

  function makeJob(onExhausted: () => Promise<void>) {
    const actionable = [
      TransactionRequestStatus.PENDING,
      TransactionRequestStatus.BROADCASTING,
      TransactionRequestStatus.BROADCASTED,
    ];

    class PinTestJob extends ScheduledRowProcessor {
      readonly actionableStatuses = actionable;
      readonly entityClass = TransactionRequestEntity;
      processRowCalls = 0;

      resolveRetryPolicy() {
        return { maxRetryTimes: 3, baseDelayMs: 1000, exponentialRate: 2 };
      }
      async processRow() {
        this.processRowCalls += 1;
        return { kind: 'fail', reason: 'forced' };
      }
      async onRetryExhausted() {
        await onExhausted();
      }
      protected async findDueRows(statuses: number[], limit: number) {
        const ctx = await startSystemTransaction('pin-test-scan');
        try {
          const rows = await relayer.findActionable(ctx, statuses, limit);
          await ctx.tx.commit();
          return rows;
        } finally {
          await ctx.tx.done();
        }
      }
      protected async scheduleNextAttempt() {
        throw new Error('scheduleNextAttempt must not be used by the exhaustion path');
      }
    }
    return new PinTestJob();
  }

  async function seedRow(requestId: string) {
    return AppDataSource.getRepository(TransactionRequestEntity).save({
      requestId,
      chainId: 56,
      userAddress: '0xuser',
      delegateContractAddress: '0xdelegate',
      feeTokenAddress: '0xfee',
      feeAmount: '1',
      atomicGroupStart: 1,
      batchNonce: '0',
      operations: [],
      signature: '0xsig',
      status: TransactionRequestStatus.PENDING,
      retryTimes: 0,
      nextRetryTime: new Date(Date.now() - 60_000),
    });
  }

  const SEEDED = ['req-throwing', 'req-terminating', 'req-ladder'];

  beforeEach(async () => {
    await AppDataSource.getRepository(TransactionRequestEntity).delete({ requestId: In(SEEDED) });
    jest.restoreAllMocks();
  });

  it('AC8 — a throwing onRetryExhausted is processed once, then skipped on later ticks', async () => {
    const seeded = await seedRow('req-throwing');
    const job = makeJob(async () => {
      throw new Error('handler exploded');
    });
    jest.spyOn(job['logger'], 'warn').mockImplementation();
    jest.spyOn(job['logger'], 'error').mockImplementation();

    await job.execute();
    await job.execute();
    await job.execute();

    expect(job.processRowCalls).toBe(1);

    const after = await AppDataSource.getRepository(TransactionRequestEntity).findOneByOrFail({ id: seeded.id });
    expect(after.nextRetryTime!.getTime()).toBeGreaterThan(Date.now());
    // Still actionable and budget untouched: the fallback pins, it does not judge.
    expect(after.status).toBe(TransactionRequestStatus.PENDING);
    expect(after.retryTimes).toBe(0);
  }, 60_000);

  it('AC4 — consecutive pins escalate 30s then 60s, measured in the database', async () => {
    const seeded = await seedRow('req-ladder');
    const job = makeJob(async () => {
      throw new Error('handler exploded');
    });
    jest.spyOn(job['logger'], 'warn').mockImplementation();
    jest.spyOn(job['logger'], 'error').mockImplementation();

    await job.execute();
    const afterFirst = await AppDataSource.getRepository(TransactionRequestEntity).findOneByOrFail({ id: seeded.id });
    expect(afterFirst.nextRetryTime!.getTime() - Date.now()).toBeGreaterThan(25_000);
    expect(afterFirst.nextRetryTime!.getTime() - Date.now()).toBeLessThan(35_000);

    // Make the row due again while preserving the 30s interval the first pin
    // left. Raw SQL so `updated_at` is set explicitly rather than by TypeORM.
    await AppDataSource.query(
      `UPDATE transaction_request SET next_retry_time = now() - interval '1 second', updated_at = now() - interval '31 seconds' WHERE id = $1`,
      [seeded.id],
    );

    await job.execute();
    const afterSecond = await AppDataSource.getRepository(TransactionRequestEntity).findOneByOrFail({ id: seeded.id });
    const secondBackoffMs = afterSecond.nextRetryTime!.getTime() - Date.now();
    expect(secondBackoffMs).toBeGreaterThan(55_000);
    expect(secondBackoffMs).toBeLessThan(65_000);
  }, 60_000);

  it('AC2 — a handler that terminates the row leaves no extra write and the row is gone from the scan', async () => {
    const seeded = await seedRow('req-terminating');
    const job = makeJob(async () => {
      await AppDataSource.getRepository(TransactionRequestEntity).update(
        { id: seeded.id },
        { status: TransactionRequestStatus.FAILED_PERMANENT },
      );
    });
    const warn = jest.spyOn(job['logger'], 'warn').mockImplementation();

    await job.execute();
    await job.execute();

    expect(job.processRowCalls).toBe(1);
    const after = await AppDataSource.getRepository(TransactionRequestEntity).findOneByOrFail({ id: seeded.id });
    expect(after.status).toBe(TransactionRequestStatus.FAILED_PERMANENT);
    // Guard matched nothing, so no pin was recorded.
    expect(warn.mock.calls.map(String).filter((m) => m.includes('scheduler_exhaustion_pinned'))).toHaveLength(0);
    expect(after.nextRetryTime!.getTime()).toBeLessThan(Date.now());
  }, 60_000);
});
