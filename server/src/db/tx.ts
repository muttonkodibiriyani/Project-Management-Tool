import pg from 'pg';

// Dates stay 'YYYY-MM-DD' (no time zone shift); numeric and bigint become numbers, as the API sends them.
pg.types.setTypeParser(pg.types.builtins.DATE, value => value);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

export type Db = pg.Pool | pg.PoolClient;

/** Runs fn in one transaction: everything it writes, activity included, commits together or not at all. */
export async function tx<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
