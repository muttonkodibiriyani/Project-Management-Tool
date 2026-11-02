import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

// Dates stay 'YYYY-MM-DD' (no time zone shift); numeric and bigint become numbers, as the API sends them.
pg.types.setTypeParser(pg.types.builtins.DATE, value => value);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export type Db = pg.Pool | pg.PoolClient;

interface DeferredAction {
  kind: 'blob';
  workspaceId: string;
  key: string;
  run: (pool: pg.Pool) => Promise<void>;
}

interface TransactionActions {
  commit: DeferredAction[];
  rollback: DeferredAction[];
}

const actions = new WeakMap<pg.PoolClient, TransactionActions>();

/**
 * Registers an external side effect that is safe only after this transaction commits.
 * Requiring the repository transaction wrapper prevents a route from quietly making Blob and PostgreSQL disagree.
 */
export function afterCommit(client: pg.PoolClient, action: DeferredAction): void {
  const current = actions.get(client);
  if (!current) throw new Error('This operation must run inside tx(pool, ...), so its commit can finalize external storage safely.');
  current.commit.push(action);
}

/** Registers compensation for an external side effect if this transaction rolls back or COMMIT fails. */
export function afterRollback(client: pg.PoolClient, action: DeferredAction): void {
  const current = actions.get(client);
  if (!current) throw new Error('This operation must run inside tx(pool, ...), so its rollback can compensate external storage safely.');
  current.rollback.push(action);
}

class DeferredActionError extends Error {
  constructor(readonly cleanupCause: unknown) {
    super('External storage cleanup failed and was queued for retry.');
  }
}

async function queue(pool: pg.Pool, action: DeferredAction): Promise<void> {
  await pool.query(
    `insert into deferred_cleanup (kind, workspace_id, key, attempts, available_at, last_attempt_at)
     values ($1, $2, $3, 1, now(), now())
     on conflict (kind, key) do update
       set workspace_id = excluded.workspace_id,
           attempts = deferred_cleanup.attempts + 1,
           available_at = now(),
           last_attempt_at = now(),
           lease_token = null`,
    [action.kind, action.workspaceId, action.key],
  );
}

async function runActions(pool: pg.Pool, pending: DeferredAction[]): Promise<void> {
  const failures: unknown[] = [];
  for (const action of pending) {
    try {
      await action.run(pool);
    } catch (error) {
      try {
        await queue(pool, action);
        failures.push(new DeferredActionError(error));
      } catch (queueError) {
        failures.push(new AggregateError([error, queueError], 'External storage cleanup and its durable retry record both failed.'));
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'One or more external storage cleanups failed.');
}

/** Runs fn in one transaction: everything it writes, activity included, commits together or not at all. */
export async function tx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const deferred: TransactionActions = { commit: [], rollback: [] };
  let outcome: { committed: true; result: T } | { committed: false; error: unknown };
  let committed = false;
  try {
    await client.query('begin');
    actions.set(client, deferred);
    const result = await fn(client);
    await client.query('commit');
    committed = true;
    outcome = { committed: true, result };
  } catch (error) {
    if (!committed) {
      await client.query('rollback').catch(() => undefined);
    }
    outcome = { committed: false, error };
  } finally {
    actions.delete(client);
    // External actions query PostgreSQL to guard ambiguous commits and record failed cleanup.
    // Return this connection first, or a full/max=1 pool deadlocks its own compensation.
    client.release();
  }

  if (outcome.committed) {
    await runActions(pool, deferred.commit);
    return outcome.result;
  }
  try {
    await runActions(pool, deferred.rollback);
  } catch (cleanupError) {
    throw new AggregateError([outcome.error, cleanupError], 'The transaction failed and its external storage cleanup was queued.');
  }
  throw outcome.error;
}

export interface DeferredCleanupItem {
  key: string;
  workspaceId: string;
  attempts: number;
  createdAt: Date;
}

export interface DeferredCleanupReport {
  completed: number;
  queueDepth: number;
  oldestAgeSeconds: number;
  maxAttempts: number;
  needsEscalation: boolean;
  failures: { keyId: string; workspaceId: string; attempts: number }[];
}

export class DeferredCleanupBatchError extends AggregateError {
  constructor(
    errors: unknown[],
    readonly report: DeferredCleanupReport,
  ) {
    super(errors, `${String(errors.length)} external storage cleanups remain queued.`);
    this.name = 'DeferredCleanupBatchError';
  }
}

const safeKeyId = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 16);

/**
 * Retries durable external cleanups without holding a PostgreSQL client across Blob I/O.
 * The atomic lease lets app instances share work; an interrupted lease becomes available again.
 */
export async function retryDeferredCleanups(
  pool: pg.Pool,
  kind: DeferredAction['kind'],
  run: (item: DeferredCleanupItem) => Promise<void>,
): Promise<DeferredCleanupReport> {
  const lease = randomUUID();
  const claimed = await pool.query<{
    key: string;
    workspace_id: string;
    attempts: number;
    created_at: Date;
  }>(
    `with picked as (
       select kind, key from deferred_cleanup
        where kind = $1 and available_at <= now()
        order by available_at, created_at
        for update skip locked
        limit 100
     )
     update deferred_cleanup d
        set lease_token = $2, available_at = now() + interval '5 minutes', last_attempt_at = now()
       from picked p
      where d.kind = p.kind and d.key = p.key
      returning d.key, d.workspace_id, d.attempts, d.created_at`,
    [kind, lease],
  );
  const errors: unknown[] = [];
  const failures: DeferredCleanupReport['failures'] = [];
  let completed = 0;
  for (const row of claimed.rows) {
    const item: DeferredCleanupItem = {
      key: row.key,
      workspaceId: row.workspace_id,
      attempts: row.attempts,
      createdAt: row.created_at,
    };
    try {
      await run(item);
      const removed = await pool.query('delete from deferred_cleanup where kind = $1 and key = $2 and lease_token = $3', [kind, row.key, lease]);
      completed += removed.rowCount ?? 0;
    } catch (error) {
      try {
        await pool.query(
          `update deferred_cleanup
              set attempts = attempts + 1, available_at = now() + interval '1 minute', last_attempt_at = now(), lease_token = null
            where kind = $1 and key = $2 and lease_token = $3`,
          [kind, row.key, lease],
        );
        errors.push(error);
      } catch (queueError) {
        errors.push(new AggregateError([error, queueError], 'External cleanup failed and its retry lease could not be released.'));
      }
      failures.push({ keyId: safeKeyId(row.key), workspaceId: row.workspace_id, attempts: row.attempts + 1 });
    }
  }
  const stats = await pool.query<{ queue_depth: number; oldest_age_seconds: number; max_attempts: number }>(
    `select count(*)::int as queue_depth,
            coalesce(extract(epoch from now() - min(created_at)), 0)::float8 as oldest_age_seconds,
            coalesce(max(attempts), 0)::int as max_attempts
       from deferred_cleanup where kind = $1`,
    [kind],
  );
  const summary = stats.rows[0] ?? { queue_depth: 0, oldest_age_seconds: 0, max_attempts: 0 };
  const report: DeferredCleanupReport = {
    completed,
    queueDepth: summary.queue_depth,
    oldestAgeSeconds: Math.max(0, summary.oldest_age_seconds),
    maxAttempts: summary.max_attempts,
    needsEscalation: summary.max_attempts >= 5 || summary.oldest_age_seconds >= 86_400,
    failures,
  };
  if (errors.length) throw new DeferredCleanupBatchError(errors, report);
  return report;
}
