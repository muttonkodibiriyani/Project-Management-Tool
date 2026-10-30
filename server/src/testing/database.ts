import { randomBytes } from 'node:crypto';
import type { TestContext } from 'node:test';
import pg from 'pg';

/**
 * Database tests run against the PostgreSQL in TEST_DATABASE_URL, as a role that may create
 * databases and roles (CI's service container; locally, any throwaway PostgreSQL 16). Each call
 * makes a new empty database, dropped when the test ends, so test files run in parallel.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';
export const APP_ROLE_PASSWORD = 'synthetic-app-password';

export function skipWithoutDatabase(t: TestContext): boolean {
  if (TEST_DATABASE_URL) return false;
  if (process.env.CI) throw new Error('TEST_DATABASE_URL is not set, so the database tests cannot run in CI. Set it on the job that runs npm test.');
  t.skip('TEST_DATABASE_URL is not set: start a throwaway PostgreSQL 16 and set it, as the README says, to run the database tests');
  return true;
}

/** Creates lt_app, the role the app runs as (the deploy script makes it in Azure), if this server lacks it. */
async function ensureAppRole(admin: pg.Client) {
  try {
    await admin.query(`create role lt_app login password '${APP_ROLE_PASSWORD}'`);
  } catch (error) {
    // 42710: it exists. 23505: another test file created it at the same moment.
    const code = (error as { code?: string }).code;
    if (code !== '42710' && code !== '23505') throw error;
  }
}

export interface TestDatabase {
  /** A client of this database, as the admin role or as `user`; closed before the database is dropped. */
  connect: (user?: string, password?: string) => Promise<pg.Client>;
}

export async function emptyDatabase(t: TestContext): Promise<TestDatabase> {
  const name = `lt_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  try {
    await ensureAppRole(admin);
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const clients: pg.Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map(client => client.end()));
    const cleanup = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await cleanup.connect();
    try {
      await cleanup.query(`drop database if exists ${name} with (force)`);
    } finally {
      await cleanup.end();
    }
  });
  return {
    connect: async (user, password) => {
      const url = new URL(TEST_DATABASE_URL);
      url.pathname = `/${name}`;
      if (user) {
        url.username = user;
        url.password = password ?? '';
      }
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      clients.push(client);
      return client;
    },
  };
}
