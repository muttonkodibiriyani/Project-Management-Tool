import pg from 'pg';

// Dates stay 'YYYY-MM-DD' (no time zone shift); numeric and bigint become numbers, as the API sends them.
pg.types.setTypeParser(pg.types.builtins.DATE, value => value);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export type Db = pg.Pool | pg.PoolClient;

interface DeferredAction {
  kind: 'blob';
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

class DeferredCleanupError extends Error {
  constructor(readonly cleanupCause: unknown) {
    super('External storage cleanup failed and was queued for retry.');
  }
}

async function queue(pool: pg.Pool, action: DeferredAction): Promise<void> {
  await pool.query(
    `insert into deferred_cleanup (kind, key, attempts, last_attempt_at) values ($1, $2, 1, now())
     on conflict (kind, key) do update set attempts = deferred_cleanup.attempts + 1, last_attempt_at = now()`,
    [action.kind, action.key],
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
        failures.push(new DeferredCleanupError(error));
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
  let committed = false;
  try {
    await client.query('begin');
    actions.set(client, deferred);
    const result = await fn(client);
    await client.query('commit');
    committed = true;
    actions.delete(client);
    await runActions(pool, deferred.commit);
    return result;
  } catch (error) {
    actions.delete(client);
    if (!committed) {
      await client.query('rollback').catch(() => undefined);
      try {
        await runActions(pool, deferred.rollback);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'The transaction failed and its external storage cleanup was queued.');
      }
    }
    throw error;
  } finally {
    actions.delete(client);
    client.release();
  }
}

/** Retries durable external cleanups. Concurrent app instances divide the queue with SKIP LOCKED. */
export async function retryDeferredCleanups(pool: pg.Pool, kind: DeferredAction['kind'], run: (key: string) => Promise<void>): Promise<number> {
  const client = await pool.connect();
  const failures: unknown[] = [];
  let completed = 0;
  try {
    await client.query('begin');
    const { rows } = await client.query<{ key: string }>(
      `select key from deferred_cleanup where kind = $1 order by created_at for update skip locked limit 100`,
      [kind],
    );
    for (const row of rows) {
      try {
        await run(row.key);
        await client.query('delete from deferred_cleanup where kind = $1 and key = $2', [kind, row.key]);
        completed += 1;
      } catch (error) {
        failures.push(error);
        await client.query('update deferred_cleanup set attempts = attempts + 1, last_attempt_at = now() where kind = $1 and key = $2', [kind, row.key]);
      }
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (failures.length) throw new AggregateError(failures, `${String(failures.length)} external storage cleanups remain queued.`);
  return completed;
}
