import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import Fastify, { type LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { APP_ROLES, type AppRole } from '../auth/roles.js';
import { SESSION_COOKIE } from '../auth/plugin.js';
import { apiFixture, USERS, WS, type UserName } from '../testing/api.js';
import { skipWithoutDatabase } from '../testing/database.js';
import { api, RATE_LIMIT } from './plugin.js';

const MEMBERS = (Object.keys(USERS) as UserName[]).filter(name => name !== 'outsider');
const problem = (response: LightMyRequestResponse) => response.json<{ code: string; detail: string }>();
const TEST_ID = '00000000-0000-4000-8000-000000000000';

const ALL_ROLES: readonly AppRole[] = APP_ROLES;
const EDITORS: readonly AppRole[] = APP_ROLES.filter(role => role !== 'Viewer');
const MANAGERS: readonly AppRole[] = ['Workspace.Admin', 'Launch.Manager'];
const ADMINS: readonly AppRole[] = ['Workspace.Admin'];

/**
 * The intended policy, written independently of each route's production config.access declaration.
 * Both sides are exhaustive: a registered route missing here, or a stale row with no route, fails.
 */
const EXPECTED_ROUTE_ROLES = {
  'DELETE /api/v1': ALL_ROLES,
  'DELETE /api/v1/*': ALL_ROLES,
  'DELETE /api/v1/me/favourites/:kind/:id': ALL_ROLES,
  'DELETE /api/v1/me/sessions/:id': ALL_ROLES,
  'DELETE /api/v1/w/:ws/comments/:id': EDITORS,
  'DELETE /api/v1/w/:ws/comments/:id/reactions/:emoji': EDITORS,
  'DELETE /api/v1/w/:ws/members/:userId': ADMINS,
  'DELETE /api/v1/w/:ws/milestones/:id': MANAGERS,
  'DELETE /api/v1/w/:ws/projects/:id': MANAGERS,
  'DELETE /api/v1/w/:ws/subtasks/:id': EDITORS,
  'DELETE /api/v1/w/:ws/tasks/:id': EDITORS,
  'DELETE /api/v1/w/:ws/tasks/:id/dependencies/:otherId': EDITORS,
  'DELETE /api/v1/w/:ws/teams/:id': ADMINS,
  'DELETE /api/v1/w/:ws/teams/:id/members/:userId': ADMINS,
  'DELETE /api/v1/w/:ws/views/:id': ALL_ROLES,
  'GET /api/v1': ALL_ROLES,
  'GET /api/v1/*': ALL_ROLES,
  'GET /api/v1/me': ALL_ROLES,
  'GET /api/v1/me/notifications': ALL_ROLES,
  'GET /api/v1/me/sessions': ALL_ROLES,
  'GET /api/v1/w/:ws': ALL_ROLES,
  'GET /api/v1/w/:ws/activity': ALL_ROLES,
  'GET /api/v1/w/:ws/bootstrap': ALL_ROLES,
  'GET /api/v1/w/:ws/changes': ALL_ROLES,
  'GET /api/v1/w/:ws/members': ALL_ROLES,
  'GET /api/v1/w/:ws/projects': ALL_ROLES,
  'GET /api/v1/w/:ws/projects/:id': ALL_ROLES,
  'GET /api/v1/w/:ws/search': ALL_ROLES,
  'GET /api/v1/w/:ws/tasks': ALL_ROLES,
  'GET /api/v1/w/:ws/tasks/:id': ALL_ROLES,
  'GET /api/v1/w/:ws/tasks/:id/comments': ALL_ROLES,
  'GET /api/v1/w/:ws/tasks/:id/stores': ALL_ROLES,
  'GET /api/v1/w/:ws/teams': ALL_ROLES,
  'GET /api/v1/w/:ws/teams/:id': ALL_ROLES,
  'GET /api/v1/w/:ws/views': ALL_ROLES,
  'GET /api/v1/workspaces': ALL_ROLES,
  'OPTIONS /api/v1': ALL_ROLES,
  'OPTIONS /api/v1/*': ALL_ROLES,
  'PATCH /api/v1': ALL_ROLES,
  'PATCH /api/v1/*': ALL_ROLES,
  'PATCH /api/v1/me': ALL_ROLES,
  'PATCH /api/v1/me/notifications/:id': ALL_ROLES,
  'PATCH /api/v1/w/:ws': ADMINS,
  'PATCH /api/v1/w/:ws/comments/:id': EDITORS,
  'PATCH /api/v1/w/:ws/members/:userId': ADMINS,
  'PATCH /api/v1/w/:ws/milestones/:id': MANAGERS,
  'PATCH /api/v1/w/:ws/projects/:id': EDITORS,
  'PATCH /api/v1/w/:ws/subtasks/:id': EDITORS,
  'PATCH /api/v1/w/:ws/tasks/:id': EDITORS,
  'PATCH /api/v1/w/:ws/tasks/:id/stores/:storeId': EDITORS,
  'PATCH /api/v1/w/:ws/teams/:id': ADMINS,
  'PATCH /api/v1/w/:ws/views/:id': ALL_ROLES,
  'POST /api/v1': ALL_ROLES,
  'POST /api/v1/*': ALL_ROLES,
  'POST /api/v1/me/notifications/read-all': ALL_ROLES,
  'POST /api/v1/w/:ws/follow-ups': EDITORS,
  'POST /api/v1/w/:ws/members': ADMINS,
  'POST /api/v1/w/:ws/projects': EDITORS,
  'POST /api/v1/w/:ws/projects/:id/milestones': MANAGERS,
  'POST /api/v1/w/:ws/tasks': EDITORS,
  'POST /api/v1/w/:ws/tasks/:id/comments': EDITORS,
  'POST /api/v1/w/:ws/tasks/:id/duplicate': EDITORS,
  'POST /api/v1/w/:ws/tasks/:id/follow-ups': EDITORS,
  'POST /api/v1/w/:ws/tasks/:id/stores': MANAGERS,
  'POST /api/v1/w/:ws/tasks/:id/subtasks': EDITORS,
  'POST /api/v1/w/:ws/tasks/bulk': EDITORS,
  'POST /api/v1/w/:ws/teams': ADMINS,
  'POST /api/v1/w/:ws/views': ALL_ROLES,
  'POST /api/v1/workspaces': ADMINS,
  'PUT /api/v1': ALL_ROLES,
  'PUT /api/v1/*': ALL_ROLES,
  'PUT /api/v1/me/favourites/:kind/:id': ALL_ROLES,
  'PUT /api/v1/w/:ws/comments/:id/reactions/:emoji': EDITORS,
  'PUT /api/v1/w/:ws/projects/:id/members': MANAGERS,
  'PUT /api/v1/w/:ws/projects/:id/references': MANAGERS,
  'PUT /api/v1/w/:ws/projects/:id/stores': MANAGERS,
  'PUT /api/v1/w/:ws/tasks/:id/dependencies/:otherId': EDITORS,
  'PUT /api/v1/w/:ws/teams/:id/members/:userId': ADMINS,
  'QUERY /api/v1': ALL_ROLES,
  'QUERY /api/v1/*': ALL_ROLES,
  'TRACE /api/v1': ALL_ROLES,
  'TRACE /api/v1/*': ALL_ROLES,
} as const satisfies Record<string, readonly AppRole[]>;

type ExpectedRoute = keyof typeof EXPECTED_ROUTE_ROLES;

function rolesDeclaredBy(access: 'any' | 'editor' | readonly AppRole[]): readonly AppRole[] {
  if (access === 'any') return ALL_ROLES;
  if (access === 'editor') return EDITORS;
  return access;
}

function requestPath(url: string): string {
  return url
    .slice('/api/v1'.length)
    .replace('/w/:ws', `/w/${WS}`)
    .replace('/:emoji', '/wave')
    .replace(/:[A-Za-z][A-Za-z0-9]*/g, TEST_ID)
    .replace(/\/\*$/, '/no-such-route');
}

test('a route without a valid access list stops the API from starting', async () => {
  // These apps never query: a pool only connects on its first query.
  const pool = new pg.Pool();
  for (const access of [undefined, ['Admin' as AppRole], []]) {
    const app = Fastify();
    await app.register(
      async scope => {
        await api(scope, { pool });
        assert.throws(
          () => scope.get('/forgotten', { config: access === undefined ? {} : { access } }, () => ({})),
          /GET \/api\/v1\/forgotten declares no valid config\.access/,
        );
      },
      { prefix: '/api/v1' },
    );
    await app.ready();
  }
});

test('the API, with real sessions in PostgreSQL', async t => {
  if (skipWithoutDatabase(t)) return;
  const f = await apiFixture(t);
  const projectCount = async () => Number((await f.db.query<{ n: string }>('select count(*) as n from project')).rows[0]?.n);

  await t.test('without a session every path answers 401, even ones that do not exist', async () => {
    for (const path of ['/me', '/no-such-thing', '', `/w/${WS}/projects`]) {
      const response = await f.call(null, 'GET', path);
      assert.equal(response.statusCode, 401, path);
      assert.equal(response.headers['content-type'], 'application/problem+json; charset=utf-8');
      assert.equal(problem(response).code, 'unauthenticated');
    }
    const forged = await f.call(null, 'GET', '/me', { headers: { cookie: `${SESSION_COOKIE}=${randomBytes(32).toString('base64url')}` } });
    assert.equal(forged.statusCode, 401);
    assert.equal((await f.call('viewer', 'GET', '/no-such-thing')).statusCode, 404);
  });

  await t.test('a session that was signed out, has expired or whose user is disabled has ended', async () => {
    for (const ended of ['revoked', 'expired'] as const) {
      const cookie = await f.session(f.users.brand.id, ended);
      const response = await f.call(null, 'GET', '/me', { headers: { cookie } });
      assert.equal(response.statusCode, 401, ended);
      assert.equal(problem(response).code, 'session_expired');
    }
    const cookie = await f.session(f.users.comms.id);
    assert.equal((await f.call(null, 'GET', '/me', { headers: { cookie } })).statusCode, 200);
    await f.db.query(`update app_user set status = 'disabled' where id = $1`, [f.users.comms.id]);
    assert.equal(problem(await f.call(null, 'GET', '/me', { headers: { cookie } })).code, 'session_expired');
    await f.db.query(`update app_user set status = 'active' where id = $1`, [f.users.comms.id]);
  });

  await t.test('a change without the CSRF header is refused before anything is written', async () => {
    const before = await projectCount();
    const refused = await f.call('admin', 'POST', `/w/${WS}/projects`, { body: { name: 'Plain', key: 'PLN', kind: 'general' }, csrf: false });
    assert.equal(refused.statusCode, 403);
    assert.equal(problem(refused).code, 'csrf_header_missing');
    assert.match(problem(refused).detail, /X-Requested-With: launch-tracker/);
    assert.equal((await f.call(null, 'POST', `/w/${WS}/projects`, { body: {}, csrf: false })).statusCode, 403, 'nor without a session');
    assert.equal(await projectCount(), before);
  });

  await t.test('a workspace you are not a member of does not exist for you', async () => {
    const response = await f.call('outsider', 'GET', `/w/${WS}/projects`);
    assert.equal(response.statusCode, 404);
    assert.equal(problem(response).code, 'not_found');
    assert.equal((await f.call('outsider', 'GET', '/me')).statusCode, 200);
  });

  await t.test('every registered route enforces its complete seven-role matrix', async () => {
    const registered = f.routes.map(route => `${route.method} ${route.url}`).sort();
    const expected = Object.keys(EXPECTED_ROUTE_ROLES).sort();
    assert.deepEqual(registered, expected, 'the independent policy table must name every registered API route, once');
    assert.ok(f.routes.length > 70, 'the matrix covers the real API, including both unknown-route handlers');
    for (const route of f.routes) {
      const key = `${route.method} ${route.url}` as ExpectedRoute;
      const expectedRoles: readonly AppRole[] = EXPECTED_ROUTE_ROLES[key];
      assert.deepEqual([...rolesDeclaredBy(route.access)].sort(), [...expectedRoles].sort(), `${key} must declare the independently expected access`);
      for (const name of MEMBERS) {
        const role = USERS[name];
        const allowed = expectedRoles.includes(role);
        const response = await f.call(name, route.method, requestPath(route.url));
        assert.equal(
          response.statusCode === 403,
          !allowed,
          `${role} ${route.method} ${route.url}: expected ${allowed ? 'the route to run' : 'the route guard to refuse'}`,
        );
        if (!allowed) assert.equal(problem(response).code, 'forbidden', `${role} ${route.method} ${route.url}`);
      }
    }
  });

  await t.test('team deletion remains admin-only under the independent policy', async () => {
    const key: ExpectedRoute = 'DELETE /api/v1/w/:ws/teams/:id';
    assert.deepEqual(EXPECTED_ROUTE_ROLES[key], ['Workspace.Admin']);
    for (const name of MEMBERS.filter(name => name !== 'admin')) {
      const response = await f.call(name, 'DELETE', `/w/${WS}/teams/${f.teams.commercial}`);
      assert.equal(response.statusCode, 403, `${USERS[name]} cannot inherit broadened member access`);
      assert.equal(problem(response).code, 'forbidden');
    }
  });

  await t.test('every workspace-scoped route checks membership before its handler', async () => {
    const workspaceRoutes = f.routes.filter(route => route.url.includes('/w/:ws'));
    assert.ok(workspaceRoutes.length > 30, 'the isolation check covers every workspace resource group');
    for (const route of workspaceRoutes) {
      const response = await f.call('outsider', route.method, requestPath(route.url));
      assert.equal(response.statusCode, 404, `${route.method} ${route.url}`);
      assert.equal(problem(response).code, 'not_found', `${route.method} ${route.url}`);
    }
  });

  await t.test('every role is checked on the server, and a refused write never reaches the database', async () => {
    const { id: projectId } = (await f.call('admin', 'POST', `/w/${WS}/projects`, { body: { name: 'Roles', key: 'ROL', kind: 'general' } })).json<{
      id: string;
    }>();
    const before = await projectCount();
    let allowed = 0;
    for (const name of MEMBERS) {
      const role = USERS[name];
      const expected = {
        read: true,
        edit: role !== 'Viewer',
        manage: role === 'Launch.Manager' || role === 'Workspace.Admin',
        admin: role === 'Workspace.Admin',
      };
      const results = {
        read: await f.call(name, 'GET', `/w/${WS}/projects/${projectId}`),
        edit: await f.call(name, 'POST', `/w/${WS}/projects`, { body: { name: `By ${name}`, key: `B${name.slice(0, 4).toUpperCase()}`, kind: 'general' } }),
        manage: await f.call(name, 'POST', `/w/${WS}/projects/${projectId}/milestones`, { body: { name: `Gate ${name}`, date: '2026-11-01' } }),
        admin: await f.call(name, 'POST', `/w/${WS}/teams`, { body: { name: `Team ${name}`, key: `team_${name}` } }),
      };
      for (const [action, response] of Object.entries(results)) {
        const ok = expected[action as keyof typeof expected];
        assert.equal(response.statusCode, ok ? (action === 'read' ? 200 : 201) : 403, `${role} ${action}`);
        if (!ok) assert.equal(problem(response).code, 'forbidden', `${role} ${action}`);
      }
      if (expected.edit) allowed++;
    }
    assert.equal(await projectCount(), before + allowed, 'only allowed creates were written');
    const milestones = await f.db.query('select 1 from milestone where project_id = $1', [projectId]);
    assert.equal(milestones.rowCount, 2, 'Launch.Manager and Workspace.Admin');
  });

  await t.test('an invalid body is a 422 that names the field', async () => {
    const response = await f.call('admin', 'POST', `/w/${WS}/projects`, { body: { name: 'X', key: 'XX', kind: 'general', colour: { hex: 1 }, extra: true } });
    assert.equal(response.statusCode, 422);
    const { code, errors } = response.json<{ code: string; errors: { path: string; code: string }[] }>();
    assert.equal(code, 'validation_failed');
    assert.deepEqual(errors.map(error => [error.path, error.code]).sort(), [
      ['colour', 'invalid_type'],
      ['extra', 'unknown_field'],
    ]);
  });

  await t.test('over the rate limit a session gets 429 with Retry-After, and others carry on', async () => {
    const cookie = await f.session(f.users.supply.id);
    for (let sent = 0; sent < RATE_LIMIT; sent++) assert.equal((await f.call(null, 'GET', '/me', { headers: { cookie } })).statusCode, 200);
    const limited = await f.call(null, 'GET', '/me', { headers: { cookie } });
    assert.equal(limited.statusCode, 429);
    assert.equal(problem(limited).code, 'rate_limited');
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal((await f.call('supply', 'GET', '/me')).statusCode, 200);
  });

  await t.test('API answers are never cached', async () => {
    assert.equal((await f.call('viewer', 'GET', '/me')).headers['cache-control'], 'private, no-store');
  });
});
