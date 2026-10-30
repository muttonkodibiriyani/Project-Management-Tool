import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import type pg from 'pg';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

/**
 * Applies every migration not yet applied, in one transaction, and returns their names. Applied
 * migrations are recorded in migrations.pgmigrations, outside the public schema, so the app role's
 * grants on public never reach the record of what ran.
 */
export async function migrate(client: pg.ClientBase, log: (message: string) => void): Promise<string[]> {
  const applied = await runner({
    dbClient: client,
    dir: MIGRATIONS_DIR,
    direction: 'up',
    migrationsTable: 'pgmigrations',
    migrationsSchema: 'migrations',
    createMigrationsSchema: true,
    checkOrder: true,
    singleTransaction: true,
    log,
  });
  return applied.map(migration => migration.name);
}
