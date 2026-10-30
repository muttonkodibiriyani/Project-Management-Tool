import type pg from 'pg';
import { ConfigError, loadDatabaseConfig, type DatabaseConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool, databaseCheck } from './dependencies.js';

/**
 * The migrate job: `node dist/migrate.js`, run once per deploy before the app starts, as the role
 * that owns the schema (lt_migrate in Azure). Running it again applies nothing.
 */
function stop(message: string): never {
  console.error(message);
  process.exit(1);
}

let config: DatabaseConfig;
try {
  config = loadDatabaseConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) stop(error.message);
  throw error;
}

const pool = createPool(config, error => {
  console.error(`The PostgreSQL connection closed during the migration: ${error.message}`);
});
let client: pg.PoolClient;
try {
  client = await pool.connect();
} catch (error) {
  stop(`The migration cannot start. ${databaseCheck(pool, config).explain(error)}`);
}
try {
  const applied = await migrate(client, () => undefined);
  console.log(applied.length ? `Applied ${applied.length} migration(s): ${applied.join(', ')}.` : 'The database is up to date; nothing to apply.');
} catch (error) {
  stop(
    `The migration of ${config.database} on ${config.host}:${config.port} failed and changed nothing: ${error instanceof Error ? error.message : String(error)}. Fix the cause and run it again.`,
  );
} finally {
  client.release();
  await pool.end();
}
