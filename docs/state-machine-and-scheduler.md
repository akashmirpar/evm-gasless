# State Machine + Scheduler — Design Spec

A self-contained specification for two composable primitives that together
let you express **"a row in a database table moves through a known set of
statuses by external action, and a background worker periodically polls the
table to advance rows that are due for processing."** Ported from the
NestJS/TypeScript implementation in this repo so it can be reimplemented in
Go (or any other language) without reading the source.

The two primitives:
1. **State Machine** — declarative, status-driven transitions enforced at the database row level via compare-and-swap. Every transition is logged.
2. **Scheduler** — a generic cron-driven row processor with a typed retry-budget pipeline. One abstract base class powers every periodic relayer/poller/reconciler job in the codebase.

Together they encode the lifecycle of every "long-running, multi-step, must-survive-crashes" task: gasless transaction broadcast, bridge status polling, periodic reconciliation, etc.

---

## 1. State Machine

### 1.1 Contract

A state machine is defined by a fixed table of `(fromStatus, action) → toStatus` transitions. Statuses and actions are both small integer enums. The FSM exposes two operations:

- `next(from, action) → toStatus | undefined` — pure lookup; returns the destination if the transition is defined, otherwise undefined.
- `can(from, action) → bool` — same as `next` but returns a boolean.

Transitions are registered once at construction. A duplicate `(from, action)` pair is a programming error and must reject at construction time (panic / throw at startup, not at runtime).

### 1.2 Why integers, not strings

Status and action are stored on the row as `smallint` (one byte) columns. Names are for human readers only; persistence and FSM lookups operate on integer values. This:

- Keeps the column small (1 byte vs N bytes for a name).
- Makes the wire format stable when the enum is renamed (the integer value is the contract).
- Makes the FSM lookup table a flat hash on two integers.

Renaming a status or action is safe. Reordering enum values is **not** — never change an integer value once it's in production; deprecate the old enum value and add a new one if you need to.

### 1.3 Transition execution

Calling the FSM directly (`next`/`can`) is a pure lookup. To actually transition a row in the database, use the `transitionStatus` operation, which does five things in one transaction:

1. Load the row by ID (error if not found).
2. Look up `next(row.status, action)`. If undefined → throw "illegal transition" with structured context (from, action).
3. Issue a **conditional UPDATE**: `UPDATE table SET status = :to WHERE id = :id AND status = :from`. The `AND status = :from` clause is the compare-and-swap that makes this safe under concurrent transitions.
4. If `result.affectedRows == 0` → throw "concurrent transition". The row was updated by someone else between step 1 and step 3. The caller should retry from scratch (rare in practice).
5. Insert a row into `transition_log` recording `(entity_name, entity_id, from_status, to_status, action, transition_by, metadata)`.

All five steps run inside one DB transaction passed in by the caller. If the surrounding transaction rolls back, the transition rolls back too (including the log entry).

### 1.4 Transition log

Every successful transition emits a row in `transition_log`. The columns:

| column         | type         | notes                                                              |
| -------------- | ------------ | ------------------------------------------------------------------ |
| id             | uuid         | primary key                                                        |
| created_at     | timestamptz  | auto-populated                                                     |
| entity         | varchar      | class/table name of the row that transitioned                      |
| entity_id      | uuid         | row id                                                             |
| from_status    | smallint     | the status before                                                  |
| to_status      | smallint     | the status after                                                   |
| action         | smallint     | the action that was applied                                        |
| transition_by  | varchar/null | actor id from the context; null when the actor is the system itself |
| metadata       | jsonb/null   | caller-supplied bag, e.g. block number, tx hash, error reason     |

Index `(entity, entity_id, created_at)` so the per-row history is fast.

The log is the canonical "what happened to this row, in what order" record. The relayer, the polling jobs, and downstream consumers all rely on it being complete: any time a row's status changes, there is one row in the log. No silent transitions, no batched transitions, no "I'll log this later."

### 1.5 What the FSM is NOT

The FSM does **not**:

- Run side effects (don't put HTTP calls or external state changes inside transition handlers — there are no handlers).
- Decide WHEN to transition. That's the scheduler's job.
- Decide WHO can transition. That's the caller's job, enforced at the controller/service layer before calling `transitionStatus`.

The FSM only answers: "is this transition allowed, and what's the next status." Everything else lives in the scheduler or the calling service.

### 1.6 Reference: every relayer's FSM

For the gasless EVM relayer, statuses are:

```
PENDING            = 0
BROADCASTING       = 10
BROADCASTED        = 20
MINED_SUCCESS      = 30
MINED_FAILED       = 40
FAILED_PERMANENT   = 90
```

Actions:

```
START_BROADCAST       = 1
BROADCAST_SUCCEEDED   = 2
BROADCAST_FAILED      = 3
MARK_MINED_SUCCESS    = 4
MARK_MINED_FAILED     = 5
GIVE_UP               = 6
```

Transitions:

```
PENDING        + START_BROADCAST     → BROADCASTING
BROADCASTING   + BROADCAST_SUCCEEDED → BROADCASTED
BROADCASTING   + BROADCAST_FAILED    → PENDING
BROADCASTED    + MARK_MINED_SUCCESS  → MINED_SUCCESS
BROADCASTED    + MARK_MINED_FAILED   → MINED_FAILED
PENDING        + GIVE_UP             → FAILED_PERMANENT
BROADCASTING   + GIVE_UP             → FAILED_PERMANENT
BROADCASTED    + GIVE_UP             → FAILED_PERMANENT
```

Terminal statuses (the row is done, the scheduler ignores it): `MINED_SUCCESS`, `MINED_FAILED`, `FAILED_PERMANENT`.

This is the canonical shape of any "broadcast something, wait for it to land, succeed-or-fail" workflow. A new domain (e.g. bridge status reconciler) follows the same shape with different action/status names.

---

## 2. Scheduler

### 2.1 Two-layer abstraction

The scheduler is split into two layers because they have different scopes:

- **`BaseJob`** — minimal interface for "anything that runs on a cron". Just `execute() → Future<void>` plus a `name` property. Direct implementers exist (one-off reconciliation jobs) but most jobs go through the second layer.
- **`ScheduledRowProcessor<S, E>`** — generic `BaseJob` for the common case: "scan a stateful table, pick up rows that are due, process each one, advance its status or schedule a retry." Almost every job inherits this.

### 2.2 `BaseJob`

```
abstract class BaseJob {
  abstract execute(): Promise<void>;
  get name(): string  // defaults to className
}
```

That's it. The scheduler service calls `execute()` on its cron tick. Errors thrown out of `execute()` are caught and logged; they don't kill the cron.

### 2.3 `ScheduledRowProcessor<S, E>` — the row-driven pipeline

A generic abstract base class for the "scan-and-advance" pattern. Two type parameters:

- `S extends number` — the status enum type (e.g. `TransactionRequestStatus`).
- `E extends BaseStatefulEntity<S>` — the row type (entity with at least `id`, `status`, `retryTimes`, `nextRetryTime`, and the per-row retry-policy columns).

The base class implements the polling loop and the retry pipeline. Subclasses fill in six abstract members:

| member                            | what it does                                                              |
| --------------------------------- | ------------------------------------------------------------------------- |
| `actionableStatuses: S[]`         | which statuses to scan for on each tick                                   |
| `entityClass`                     | the entity the base class targets for the exhaustion-fallback UPDATE (§2.8) |
| `resolveRetryPolicy(row): Policy` | fallback retry policy when the row's per-row columns are null             |
| `processRow(row): ProcessRowResult` | the per-row work; returns one of four results (see below)                |
| `onRetryExhausted(row, reason)`   | called when retry budget is hit — typically transitions row to GIVE_UP    |
| `findDueRows(statuses, limit)`    | how to query the table (left abstract so the caller can plug in its repo)  |
| `scheduleNextAttempt(row, retryTimes, nextRetryTime)` | how to update the row's retry bookkeeping (same reason — caller's repo) |

### 2.4 `ProcessRowResult` — the four outcomes

`processRow` must return one of four discriminated-union variants. The base class branches on the kind:

```
{ kind: 'done' }                                 // row is fully handled; do nothing
{ kind: 'reschedule', reason: string }           // bump retryTimes, set nextRetryTime via backoff
{ kind: 'wait',       reason: string }           // do NOT bump retryTimes; just set nextRetryTime = now + baseDelayMs
{ kind: 'fail',       reason: string }           // immediately call onRetryExhausted (no more attempts)
```

The semantic difference between `reschedule` and `wait` is intentional and important:

- `reschedule` consumes one retry budget unit. After `maxRetryTimes` consecutive reschedules, the base class calls `onRetryExhausted` — the row is presumed broken.
- `wait` does NOT consume budget. Use this when you genuinely don't know if the row is broken — e.g. "the transaction is still pending on chain; check again later." A row that's been waiting for 100 ticks is not broken; it's just slow.

Use `fail` for definitive terminal errors that won't get better with retries (e.g. simulation rejected with a known-permanent error pattern).

**Uncaught exceptions in `processRow` are treated as `wait`, not `reschedule`.** This is deliberate. If the worker crashes mid-process due to an internal bug or a transient DB hiccup, we don't want that to consume retry budget — the next tick should try again with no penalty. Genuine "this row will never succeed" must be returned explicitly as `{ kind: 'fail' }`.

### 2.5 The retry policy

```
Policy = {
  maxRetryTimes: int    // budget for reschedules
  baseDelayMs:   int    // delay for wait; base for reschedule's exponential backoff
  exponentialRate: float // multiplier per attempt; baseDelayMs * rate^retryTimes
}
```

For a given row, the **effective** policy is computed as follows:

```
if row.maxRetryTimes != null AND row.baseDelayMs != null AND row.exponentialRate != null:
    use those three values
else:
    call subclass.resolveRetryPolicy(row)
```

The per-row columns let you snapshot policy at row creation, so changing the global default doesn't retroactively affect in-flight rows. The fallback to `resolveRetryPolicy(row)` is for legacy rows that predate the columns, and for non-row-driven jobs whose policy is global.

Backoff time for the N-th reschedule: `baseDelayMs * exponentialRate^N`. Example with `baseDelayMs=5000, exponentialRate=2`: 5s, 10s, 20s, 40s, 80s, …

### 2.6 The pipeline (pseudocode)

```
async execute():
    if running: return
    running = true
    try:
        rows = await findDueRows(actionableStatuses, batchSize)
        for row in rows:
            await processWithRetry(row)
    catch err:
        logger.error("tick failed", err)
    finally:
        running = false

async processWithRetry(row):
    policy = effectiveRetryPolicy(row)  // throws → applyExhaustionBackoff("unresolvable_policy"); handler NOT called
    try:
        result = await processRow(row)
    catch err:
        logger.warn("processRow threw — waiting (no budget cap)", id=row.id, err)
        await scheduleWait(row, policy)
        return

    switch result.kind:
        case 'done':
            return
        case 'fail':
            await runExhaustion(row, result.reason)
            return
        case 'wait':
            await scheduleWait(row, policy)
            return
        case 'reschedule':
            await scheduleRetry(row, policy, result.reason)

async runExhaustion(row, reason):
    ok = await safeOnExhausted(row, reason)          // never throws; reports success
    await applyExhaustionBackoff(row, reason, ok ? "handler_noop" : "handler_threw")

async applyExhaustionBackoff(row, reason, cause):
    // Guarded: only pins a row the handler left actionable. Writes nextRetryTime
    // ONLY — retryTimes is the shared budget read by isRetryExhausted.
    delay = clamp(2 * (row.nextRetryTime - row.updatedAt), 30s, 5min)
    affected = UPDATE <entity> SET next_retry_time = now + delay
               WHERE id = row.id AND status IN actionableStatuses
    if affected == 0: return                          // handler moved it — silent no-op
    logger.warn("scheduler_exhaustion_pinned", {entity, id, reason, cause, nextRetryTime, backoffMs})

async scheduleWait(row, policy):
    // do NOT bump retryTimes
    await scheduleNextAttempt(row, row.retryTimes, now + policy.baseDelayMs)

async scheduleRetry(row, policy, reason):
    next = row.retryTimes + 1
    if next >= policy.maxRetryTimes:
        await runExhaustion(row, "retry_exhausted:" + reason)
        return
    await scheduleNextAttempt(row, next, now + policy.baseDelayMs * policy.exponentialRate^next)
```

The `running` guard is intra-process (a boolean field on the subclass instance). It prevents reentrant ticks if the previous tick is still running when the next cron fires. Note this guard is per-instance: it does NOT protect against multiple replicas of the same job in different processes. (That's a deliberate non-feature; see §2.10.)

### 2.7 `SchedulerService`

Jobs register themselves at construction:

```
schedulerService.register(name, jobInstance, defaultCronTime)
```

At application bootstrap, the service iterates registered jobs and mounts each as a cron job (using whatever cron library the host language has). Cron times are overridable per job via an env var named `<NAME>_TIME`.

Standard names use `SCREAMING_SNAKE_CASE` strings, declared in a single shared file:

```
const SchedulerName = {
  EvmRelayer:     "SCHEDULER_EVM_RELAYER",
  ...
}
```

The override env var for `SCHEDULER_EVM_RELAYER` is `SCHEDULER_EVM_RELAYER_TIME`.

**Default cron values currently in use (gasless backend):**

- `RELAYER_CRON` — defaults to `*/5 * * * * *` (every 5 seconds).

Status-polling cadence on the client side should NOT be tighter than this — there's no point checking more often than the backend itself ticks. 2-5 seconds is the sweet spot for client polling.

### 2.8 Logging

The base class logs at three points:

- `info` when `effectiveRetryPolicy` falls back due to legacy rows (omit if noisy).
- `warn` when `processRow` throws an uncaught exception (with row id and error message).
- `warn` when a row hits retry exhaustion (with row id, reason, retryTimes, maxRetryTimes).
- `error` when `onRetryExhausted` itself throws. The row is then *pinned*, not stuck: the exhaustion fallback backs it off so it cannot be re-selected on the next tick.
- `warn` `scheduler_exhaustion_pinned` `{entity, id, reason, cause, nextRetryTime, backoffMs}` — emitted once per fallback UPDATE that actually pinned a row. `cause` is `handler_threw` (the handler raised), `handler_noop` (it returned but left the row actionable), or `unresolvable_policy` (no policy could be resolved, so the handler was deliberately not called — an unresolvable policy is an infrastructure fault, not a verdict on the row). A steady stream of these is the alerting signal for a row that cannot terminate.
- `error` `scheduler_exhaustion_backoff_failed` / `scheduler_exhaustion_backoff_release_failed` when the fallback UPDATE or its connection release fails. Both are swallowed: a pinned row is the oldest and heads every batch, so letting either escape would drop the rest of the tick.

The backoff doubles the interval the row was last scheduled with (`nextRetryTime - updatedAt`), clamped to 30s..5min, so repeated pins decay 30s → 60s → 120s → 240s → 300s. It continues the row's existing interval rather than restarting it: a row that spent its full retry budget arrives carrying that budget's final delay (320s with the shipped defaults) and so pins straight at the 300s ceiling, while a row with no prior interval starts at the 30s floor.

Two limitations follow from deriving the interval from `updated_at`. It works only because TypeORM appends the `@UpdateDateColumn` to the fallback UPDATE — a raw query there would flatten escalation to a permanent 30s. And any other write that moves `updated_at` without moving `next_retry_time` (an admin edit, a second replica) resets the ladder to the floor; that is bounded and self-correcting. It is deliberately independent of the job's `RetryPolicy`: at exhaustion `retryTimes >= maxRetryTimes`, so `baseDelayMs * exponentialRate^retryTimes` would produce multi-hour delays and turn a visible hot loop into an invisible stall.

### 2.9 Crash-safety guarantees

The system is crash-safe in the sense that:

- Every status change is durable (committed to DB before the worker considers it done).
- A row that's mid-process is identifiable by status (e.g. `BROADCASTING`) and gets picked back up by the next tick. The subclass's `processRow` must handle "I was selected in status X, but X is normally an intermediate" — this is the crash-recovery branch. Pattern: if a row is in `BROADCASTING` with no `txHash` written, the previous worker crashed between the status transition and the broadcast; rewind to `PENDING` and consume one retry budget unit so a permanently-broken row doesn't loop forever.
- Uncaught exceptions in `processRow` do NOT consume budget — they retry indefinitely. This is the right default because the alternative ("retry budget exhausted because a DB hiccup happened during processing") wrongly terminates rows that were never given a fair chance.

### 2.10 What the scheduler is NOT

- **Not multi-replica safe.** Two processes scanning the same table will both pick the same rows. Single-replica deployment is assumed. If you need horizontal scaling, add `FOR UPDATE SKIP LOCKED` + a claim window inside `findDueRows` — but this is deliberately not the default because it adds DB-side complexity (locking semantics, lock-hold duration, claim expiry) that isn't worth it for most deployments.
- **Not a job queue.** Jobs don't enqueue work; they poll a stateful table. If you need "post a job, run it once, persist the result" semantics, use a job queue library (Asynq, River, etc.); this scheduler is for the orthogonal case of "process every row of table T that's in status S and due now."
- **Not exactly-once.** Within one replica, processing is at-most-once-per-tick (the row's status moves out of actionable on success). Across replicas it's at-least-once if you bypass the multi-replica restriction. Idempotency is the caller's responsibility — typically by having a unique key on the row (`request_id`) and using the FSM's compare-and-swap to ensure status transitions are atomic.

---

## 3. How They Compose

A typical job extends `ScheduledRowProcessor<S, E>` and uses `transitionStatus` inside `processRow` to advance the row through the FSM. Sketch:

```
class RelayerJob extends ScheduledRowProcessor<TxStatus, TxEntity>:

  actionableStatuses = [PENDING, BROADCASTING, BROADCASTED]

  resolveRetryPolicy(row) = {
    maxRetryTimes: env("RELAYER_MAX_RETRIES", 6),
    baseDelayMs:   env("RELAYER_RETRY_BASE_MS", 5000),
    exponentialRate: 2,
  }

  findDueRows(statuses, limit) = relayerRepo.findActionable(statuses, limit)
  scheduleNextAttempt(row, retryTimes, nextRetryTime) = relayerRepo.bumpRetry(row.id, retryTimes, nextRetryTime)

  onRetryExhausted(row, reason):
    inTx:
      relayerRepo.setFailureReason(row.id, "terminal: " + reason)
      transitionStatus(row, GIVE_UP)

  processRow(row):
    if row.status == PENDING:
        return doBroadcast(row)        // → done | reschedule | fail
    if row.status == BROADCASTING:
        return recoverBroadcasting(row) // crash-recovery branch
    if row.status == BROADCASTED:
        return doCheckReceipt(row)     // → done | wait | reschedule
    return { kind: 'done' }            // terminal status — shouldn't happen, ignore

  doBroadcast(row):
    inTx: transitionStatus(row, START_BROADCAST)  // PENDING → BROADCASTING
    try:
        result = await chain.broadcast(row)
        inTx:
          setTxHash(row.id, result.hash)
          transitionStatus(row, BROADCAST_SUCCEEDED)  // BROADCASTING → BROADCASTED
        return { kind: 'done' }
    catch err:
        terminal = isTerminalBroadcastError(err.message)
        inTx:
          setFailureReason(row.id, err.message)
          transitionStatus(row, BROADCAST_FAILED)  // BROADCASTING → PENDING
        return terminal ? { kind: 'fail', reason } : { kind: 'reschedule', reason }

  recoverBroadcasting(row):
    if row.txHash != null:
        // previous worker broadcast but crashed before transitioning
        inTx: transitionStatus(row, BROADCAST_SUCCEEDED)
        return { kind: 'done' }
    // previous worker died before any progress; rewind + retry-bump
    inTx:
      setFailureReason(row.id, "crash recovery")
      transitionStatus(row, BROADCAST_FAILED)
    return { kind: 'reschedule', reason: 'crash_recovery' }

  doCheckReceipt(row):
    receipt = await chain.fetchReceipt(row)
    if receipt.status == 'pending':
        return { kind: 'reschedule', reason: 'tx_pending' }
    inTx:
      if receipt.status == 'failed':
          setFailureReason(row.id, "tx reverted at " + receipt.blockNumber)
      transitionStatus(row, receipt.status == 'success' ? MARK_MINED_SUCCESS : MARK_MINED_FAILED)
    return { kind: 'done' }
```

The FSM enforces status legality (you can't go from `BROADCASTED` to `BROADCASTING` because there's no such transition). The scheduler enforces retry budget (you can't `reschedule` more than `maxRetryTimes` times). The composition gives you a fully crash-safe, budget-bounded relayer in ~100 lines of subclass code.

---

## 4. Database Schema

### 4.1 `BaseStatefulEntity` columns

Every stateful row inherits these columns:

| column            | type        | nullable | notes                                                              |
| ----------------- | ----------- | -------- | ------------------------------------------------------------------ |
| status            | smallint    | no       | the FSM status                                                     |
| retry_times       | smallint    | no       | default 0; bumped by `scheduleRetry`                              |
| next_retry_time   | timestamptz | yes      | null = "process now"; set by `scheduleNextAttempt`                |
| max_retry_times   | smallint    | yes      | per-row policy snapshot (null → use subclass fallback)            |
| base_delay_ms     | integer     | yes      | per-row policy snapshot                                            |
| exponential_rate  | real        | yes      | per-row policy snapshot                                            |

Plus the usual `id` (uuid PK), `created_at`, `updated_at`, `deleted_at` (timestamptz).

Index on `(status, next_retry_time)` — the find query selects rows where `status IN (...) AND (next_retry_time IS NULL OR next_retry_time <= NOW())`. This index makes that scan fast even at scale.

When inserting a new row, snapshot the policy from your config/env onto the row. The base class will fall back to `resolveRetryPolicy(row)` for rows that predate this convention; new rows should always have all three columns populated.

### 4.2 `transition_log` table

| column         | type        | nullable |
| -------------- | ----------- | -------- |
| id             | uuid        | no (PK)  |
| created_at     | timestamptz | no       |
| entity         | varchar     | no       |
| entity_id      | uuid        | no       |
| from_status    | smallint    | no       |
| to_status      | smallint    | no       |
| action         | smallint    | no       |
| transition_by  | varchar     | yes      |
| metadata       | jsonb       | yes      |

Index on `(entity, entity_id, created_at)`.

This table is append-only. Never update or delete rows in it (until a retention policy says so).

---

## 5. Go Translation Notes

### 5.1 Generics

Go 1.18+ supports generics. The TypeScript signature:

```typescript
abstract class ScheduledRowProcessor<S extends number, E extends BaseStatefulEntity<S>>
```

translates to:

```go
type StatefulEntity[S ~int16] interface {
    GetID() string
    GetStatus() S
    GetRetryTimes() int16
    GetNextRetryTime() *time.Time
    GetMaxRetryTimes() *int16
    GetBaseDelayMs() *int32
    GetExponentialRate() *float32
}

type ScheduledRowProcessor[S ~int16, E StatefulEntity[S]] interface {
    BaseJob
    ActionableStatuses() []S
    ResolveRetryPolicy(row E) RetryPolicy
    ProcessRow(ctx context.Context, row E) ProcessRowResult
    OnRetryExhausted(ctx context.Context, row E, reason string) error
    FindDueRows(ctx context.Context, statuses []S, limit int) ([]E, error)
    ScheduleNextAttempt(ctx context.Context, row E, retryTimes int16, nextRetryTime time.Time) error
}
```

Go doesn't have abstract classes. The pipeline (`Execute`, `processWithRetry`, `scheduleWait`, `scheduleRetry`, `effectiveRetryPolicy`) is implemented as a struct that holds the subclass-provided callbacks (or accepts the interface above). Concrete jobs embed the helper struct or compose via interface satisfaction. Both are fine; the embedded-helper pattern matches the abstract-class shape better:

```go
type RowProcessorPipeline[S ~int16, E StatefulEntity[S]] struct {
    impl ScheduledRowProcessor[S, E]
    logger *slog.Logger
    running atomic.Bool
}

func (p *RowProcessorPipeline[S, E]) Execute(ctx context.Context) error {
    if !p.running.CompareAndSwap(false, true) {
        return nil
    }
    defer p.running.Store(false)
    rows, err := p.impl.FindDueRows(ctx, p.impl.ActionableStatuses(), p.batchSize)
    if err != nil { return err }
    for _, row := range rows {
        p.processWithRetry(ctx, row)
    }
    return nil
}
```

### 5.2 Discriminated unions

Go doesn't have native sum types. The cleanest equivalent for `ProcessRowResult`:

```go
type ProcessRowResultKind int

const (
    KindDone ProcessRowResultKind = iota
    KindReschedule
    KindWait
    KindFail
)

type ProcessRowResult struct {
    Kind   ProcessRowResultKind
    Reason string  // empty for KindDone
}

func Done() ProcessRowResult                 { return ProcessRowResult{Kind: KindDone} }
func Reschedule(reason string) ProcessRowResult { return ProcessRowResult{Kind: KindReschedule, Reason: reason} }
func Wait(reason string) ProcessRowResult       { return ProcessRowResult{Kind: KindWait,       Reason: reason} }
func Fail(reason string) ProcessRowResult       { return ProcessRowResult{Kind: KindFail,       Reason: reason} }
```

### 5.3 Library equivalents

| TS / NestJS                   | Go                                          |
| ----------------------------- | ------------------------------------------- |
| `@nestjs/schedule` (cron)     | `github.com/robfig/cron/v3`                 |
| TypeORM (`createQueryBuilder`)| `github.com/jackc/pgx/v5` raw SQL, or `gorm`|
| `@nestjs/common` (DI)         | manual constructor injection / `fx` / `wire`|
| `Logger`                      | `log/slog` (std lib, Go 1.21+)              |
| `Promise`                     | `error`-returning functions + `context.Context` |

The TS code wraps every DB operation in a "transaction context" (`startSystemTransaction(...)`) that bundles a `tx.manager` and an actor identity. In Go, pass a `pgx.Tx` (or your ORM's equivalent) explicitly:

```go
func (s *RelayerService) FindActionable(ctx context.Context, tx pgx.Tx, statuses []int16, limit int) ([]Entity, error) {
    rows, err := tx.Query(ctx, `
        SELECT ... FROM transaction_request
        WHERE status = ANY($1) AND (next_retry_time IS NULL OR next_retry_time <= NOW())
        ORDER BY next_retry_time ASC NULLS FIRST
        LIMIT $2
    `, statuses, limit)
    ...
}
```

### 5.4 `transitionStatus` in Go

```go
func TransitionStatus[S ~int16, A ~int16](
    ctx context.Context,
    tx pgx.Tx,
    table string,
    entityID string,
    action A,
    fsm *StateMachine[S, A],
    actorID *string,
    metadata map[string]any,
) (from S, to S, err error) {
    var current S
    err = tx.QueryRow(ctx, `SELECT status FROM `+table+` WHERE id = $1`, entityID).Scan(&current)
    if err != nil { return 0, 0, fmt.Errorf("load: %w", err) }

    next, ok := fsm.Next(current, action)
    if !ok {
        return current, 0, fmt.Errorf("illegal transition: from=%d action=%d", current, action)
    }

    tag, err := tx.Exec(ctx,
        `UPDATE `+table+` SET status = $1 WHERE id = $2 AND status = $3`,
        next, entityID, current)
    if err != nil { return current, next, fmt.Errorf("update: %w", err) }
    if tag.RowsAffected() == 0 {
        return current, next, fmt.Errorf("concurrent transition: id=%s expectedFrom=%d", entityID, current)
    }

    var metaJSON []byte
    if metadata != nil {
        metaJSON, _ = json.Marshal(metadata)
    }
    _, err = tx.Exec(ctx, `
        INSERT INTO transition_log (entity, entity_id, from_status, to_status, action, transition_by, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, table, entityID, current, next, action, actorID, metaJSON)
    if err != nil { return current, next, fmt.Errorf("log insert: %w", err) }

    return current, next, nil
}
```

The `tx` is supplied by the caller (their per-operation transaction). The function does no commits — that's the caller's job. Concurrent transitions surface as a typed error the caller can detect and decide whether to retry.

### 5.5 `StateMachine` in Go

```go
type Transition[S ~int16, A ~int16] struct {
    From   S
    Action A
    To     S
}

type StateMachine[S ~int16, A ~int16] struct {
    table map[uint32]S
}

func NewStateMachine[S ~int16, A ~int16](transitions []Transition[S, A]) *StateMachine[S, A] {
    m := &StateMachine[S, A]{table: make(map[uint32]S, len(transitions))}
    for _, t := range transitions {
        key := uint32(t.From)<<16 | uint32(uint16(t.Action))
        if _, dup := m.table[key]; dup {
            panic(fmt.Sprintf("FSM duplicate transition: from=%d action=%d", t.From, t.Action))
        }
        m.table[key] = t.To
    }
    return m
}

func (m *StateMachine[S, A]) Next(from S, action A) (S, bool) {
    key := uint32(from)<<16 | uint32(uint16(action))
    to, ok := m.table[key]
    return to, ok
}

func (m *StateMachine[S, A]) Can(from S, action A) bool {
    _, ok := m.Next(from, action)
    return ok
}
```

---

## 6. Edge Cases / Gotchas

1. **Don't commit between status load and conditional UPDATE in `transitionStatus`.** The whole point of the compare-and-swap is that the row's status hasn't changed since you read it. If you commit in between, another worker can race in. Keep the read + update + log insert in one transaction.

2. **The "wait" vs "reschedule" choice matters.** Use `wait` for "this row is fine but I need to check later" (e.g. tx is mining). Use `reschedule` for "this row encountered an error that might be transient." Mixing them up either retries forever (you used `wait` when you should've budgeted) or terminates rows too aggressively (you used `reschedule` for benign pending states).

3. **The `running` guard is per-process, not per-row.** Two processes running the same job will both scan the table and pick up the same rows. The codebase assumes single-replica deployment. To go multi-replica, see §2.10.

4. **The crash-recovery branch is mandatory.** Whenever you have a "mid-flight" status like `BROADCASTING`, your `processRow` must handle a row that arrives in that status. Failure mode otherwise: the previous worker crashed, the row is stuck in `BROADCASTING` forever because nothing transitions it out, the scheduler keeps selecting it, doing nothing, infinite loop.

5. **Per-row policy snapshot is point-in-time.** If you change the global `RELAYER_MAX_RETRIES` env var, in-flight rows still use their snapshotted policy. New rows pick up the new value. Plan around this — don't change retry policies expecting them to apply to existing rows.

6. **The transition log is append-only.** Never UPDATE or DELETE rows in it. If you need to "undo" a transition, that's a new transition (e.g. PENDING → BROADCASTING → PENDING from the BROADCAST_FAILED action) — the log shows the path taken.

7. **Status enum integer values are forever.** Once a value is in production, never reuse it. Add a new enum value if semantics change. Renaming the symbol is fine; the database stores the integer.

8. **`onRetryExhausted` runs OUTSIDE `processRow`.** Don't put complex logic in it — it's called after the pipeline already decided this row is done. Typical implementation: set a failure reason on the row, transition to GIVE_UP/FAILED status, commit. Keep it idempotent.

9. **Uncaught exceptions are at-most-once-per-tick.** A bug in `processRow` that throws on a specific row will cause that row to be picked up every tick forever (with `wait` semantics — no budget consumed). Make sure you have alerting on persistently-stuck rows; otherwise this is a silent infinite loop.

10. **`findDueRows` should `ORDER BY next_retry_time ASC`.** Otherwise a row that was rescheduled five minutes ago can be starved by newer rows. Pre-FIFO is the right default for fairness.

---

## 7. Quick Reference — Files In This Repo

For implementers who want to read the TypeScript source:

- `src/common/base-stateful.entity.ts` — `BaseStatefulEntity` columns
- `src/common/transition_log.entity.ts` — `TransitionLogEntity`
- `src/core/fsm/state_machine.ts` — `StateMachine<S, A>`
- `src/core/fsm/transition_status.ts` — `transitionStatus` operation
- `src/core/scheduler/base.job.ts` — `BaseJob`
- `src/core/scheduler/retry_policy.ts` — `RetryPolicy` + helpers
- `src/core/scheduler/scheduled_row_processor.ts` — the pipeline
- `src/core/scheduler/scheduler.service.ts` — cron registration + boot
- `src/core/scheduler/scheduler_name.ts` — central name registry
- `src/modules/relayer/jobs/relayer.job.ts` — the relayer consumer
- `src/modules/relayer/fsm/transaction_request.fsm.ts` — the FSM declaration
- `src/modules/relayer/domain/entity/status/transaction_request.{status,action}.ts` — status/action enums

The relayer job is the canonical reference implementation. Read it for the full crash-safety + retry semantics in action.
