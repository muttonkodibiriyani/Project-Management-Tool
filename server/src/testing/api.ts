import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { APP_ROLES, type AppRole } from '../access/policy.js';
import { SESSION_COOKIE } from '../api/context.js';
import { buildApp } from '../app.js';
import { migrate } from '../db/migrate.js';
import { APP_ROLE_PASSWORD, emptyDatabase, TEST_DATABASE_URL } from './database.js';

/** One synthetic user per Entra app role, plus a Launch.Manager who is in no workspace. */
export const USERS = {
  admin: 'Workspace.Admin',
  manager: 'Launch.Manager',
  brand: 'BrandTeam',
  supply: 'Supply',
  vm: 'VM',
  comms: 'Comms',
  viewer: 'Viewer',
  outsider: 'Launch.Manager',
} as const satisfies Record<string, AppRole>;
export type UserName = keyof typeof USERS;

/** Team key → the role user who is in it. `commercial` has no app role (it sees margins by membership). */
const TEAMS = { brand: 'brand', supply: 'supply', vm: 'vm', comms: 'comms', commercial: null } as const;

export const WS = 'synthetic';
/** The routes tasks.test.ts covers; workspace.test.ts covers the rest of the API. */
export const TASK_ROUTES = ['/w/:ws/tasks', '/w/:ws/follow-ups', '/w/:ws/subtasks', '/w/:ws/comments'];

export interface Fixture {
  app: FastifyInstance;
  /** The database as its owner, for setting up rows and checking what was written. */
  db: pg.Client;
  workspaceId: string;
  users: Record<UserName, { id: string; cookie: string }>;
  teams: Record<keyof typeof TEAMS, string>;
  stores: { DFC: string; VLG: string };
  templateId: string;
  brandId: string;
  /** A request to /api/v1 as `user` (null: no session), with the CSRF header on unless `csrf: false`. */
  call: (user: UserName | null, method: string, path: string, options?: CallOptions) => Promise<LightMyRequestResponse>;
  /** A new session for the user; `ended` revokes or expires it. Returns the cookie header. */
  session: (userId: string, ended?: 'revoked' | 'expired') => Promise<string>;
  /** Fails if a route under one of `prefixes` (after /api/v1), and not under one of `except`, was never called. */
  assertCovered: (prefixes: string[], except?: string[]) => void;
}

interface CallOptions {
  body?: unknown;
  headers?: Record<string, string>;
  csrf?: boolean;
}

/**
 * A migrated database with one synthetic workspace, and the app on it running as lt_app, as in Azure.
 * Template fields: zone (line text), channel (line select, one archived option), supply_ready (line gate
 * of supply) and vm_dressed (line × store gate of vm).
 */
export async function apiFixture(t: TestContext): Promise<Fixture> {
  // After-hooks run in the order they are added: the app and its pool close before the database is dropped.
  const closing: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of closing) await close();
  });
  const database = await emptyDatabase(t);
  const db = await database.connect();
  await migrate(db, () => undefined);
  const one = async (sql: string, params: unknown[] = []) => {
    const { rows } = await db.query<{ id: string }>(`${sql} returning id`, params);
    return rows[0]?.id ?? '';
  };

  const workspaceId = await one(`insert into workspace (slug, name) values ($1, 'Synthetic Retail')`, [WS]);
  const users = {} as Fixture['users'];
  const session = async (userId: string, ended?: 'revoked' | 'expired') => {
    const token = randomBytes(32).toString('base64url');
    await db.query(
      `insert into user_session (user_id, token_hash, expires_at, revoked_at)
       values ($1, $2, now() + case when $3 = 'expired' then interval '-1 minute' else interval '12 hours' end, case when $3 = 'revoked' then now() end)`,
      [userId, createHash('sha256').update(token).digest(), ended ?? null],
    );
    return `${SESSION_COOKIE}=${token}`;
  };
  for (const [name, role] of Object.entries(USERS) as [UserName, AppRole][]) {
    const id = await one(`insert into app_user (email, name, app_roles) values ($1, $2, $3)`, [`${name}@example.test`, `Test ${name}`, [role]]);
    if (name !== 'outsider') {
      await db.query('insert into workspace_member (workspace_id, user_id, gr8r_role) values ($1, $2, $3)', [
        workspaceId,
        id,
        name === 'admin' ? 'Owner' : 'Member',
      ]);
    }
    users[name] = { id, cookie: await session(id) };
  }
  const teams = {} as Fixture['teams'];
  for (const [key, member] of Object.entries(TEAMS) as [keyof typeof TEAMS, UserName | null][]) {
    teams[key] = await one(`insert into team (workspace_id, key, name, app_role) values ($1, $2, $2, $3)`, [workspaceId, key, member ? USERS[member] : null]);
    if (member) await db.query(`insert into team_member (team_id, user_id, source) values ($1, $2, 'entra')`, [teams[key], users[member].id]);
  }
  const store = (code: string) => one(`insert into store (workspace_id, code, name, market_code) values ($1, $2, $2, 'QAT')`, [workspaceId, code]);
  const stores = { DFC: await store('DFC'), VLG: await store('VLG') };
  const templateId = await one(`insert into template (workspace_id, key, name, kind) values ($1, 'gcc_store_launch', 'GCC store launch', 'launch')`, [
    workspaceId,
  ]);
  const listId = await one(`insert into value_list (workspace_id, key, name) values ($1, 'channel', 'Channel')`, [workspaceId]);
  await db.query(
    `insert into list_option (list_id, key, label, position, archived) values ($1, 'retail', 'Retail', 1, false), ($1, 'online', 'Online', 2, false), ($1, 'kiosk', 'Kiosk', 3, true)`,
    [listId],
  );
  await db.query(
    `insert into field_def (workspace_id, template_id, scope, key, label, type, list_id, position, is_gate, owner_team_id) values
       ($1, $2, 'line', 'zone', 'Zone', 'text', null, 1, false, null),
       ($1, $2, 'line', 'channel', 'Channel', 'select', $3, 2, false, null),
       ($1, $2, 'line', 'supply_ready', 'Supply ready', 'boolean', null, 3, true, $4),
       ($1, $2, 'line_store', 'vm_dressed', 'VM dressed', 'boolean', null, 4, true, $5)`,
    [workspaceId, templateId, listId, teams.supply, teams.vm],
  );
  const brandId = await one(`insert into brand (workspace_id, name, name_norm) values ($1, 'Northwind Atelier', 'northwind atelier')`, [workspaceId]);

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${(await db.query<{ name: string }>('select current_database() as name')).rows[0]?.name ?? ''}`;
  url.username = 'lt_app';
  url.password = APP_ROLE_PASSWORD;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });

  const app = buildApp({
    publicDir: mkdtempSync(join(tmpdir(), 'lt-public-')),
    pool,
    health: () => Promise.resolve({ status: 'ok', commit: '', imageDigest: '', checks: [] }),
  });
  const routes = new Set<string>();
  app.addHook('onRoute', route => {
    if (route.url.startsWith('/api/v1/')) for (const method of [route.method].flat()) if (method !== 'HEAD') routes.add(`${method} ${route.url}`);
  });
  const called = new Set<string>();
  app.addHook('onResponse', (request, _reply, done) => {
    called.add(`${request.method} ${request.routeOptions.url ?? ''}`);
    done();
  });
  closing.push(
    () => app.close(),
    () => pool.end(),
  );
  await app.ready();

  const call: Fixture['call'] = (user, method, path, { body, headers = {}, csrf = true } = {}) =>
    app.inject({
      method: method as 'GET',
      url: `/api/v1${path}`,
      headers: {
        ...(user ? { cookie: users[user].cookie } : {}),
        ...(csrf ? { 'x-requested-with': 'launch-tracker' } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: body as object }),
    });

  const assertCovered: Fixture['assertCovered'] = (prefixes, except = []) => {
    const under = (route: string, list: string[]) => list.some(prefix => route.split(' ')[1]?.startsWith(`/api/v1${prefix}`));
    const missed = [...routes].filter(route => under(route, prefixes) && !under(route, except) && !called.has(route));
    assert.deepEqual(missed, [], 'every route has a test');
  };

  assert.equal(Object.keys(USERS).length - 1, APP_ROLES.length, 'one test user per app role');
  return { app, db, workspaceId, users, teams, stores, templateId, brandId, call, session, assertCovered };
}

/** If-Match for the version a response carried. */
export const ifMatch = (response: LightMyRequestResponse) => ({ 'if-match': String(response.headers.etag) });
