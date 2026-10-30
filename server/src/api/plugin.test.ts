import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import Fastify, { type LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import type { AppRole } from '../auth/roles.js';
import { SESSION_COOKIE } from '../auth/plugin.js';
import { apiFixture, USERS, WS, type UserName } from '../testing/api.js';
import { skipWithoutDatabase } from '../testing/database.js';
import { api, RATE_LIMIT } from './plugin.js';

const MEMBERS = (Object.keys(USERS) as UserName[]).filter(name => name !== 'outsider');
const problem = (response: LightMyRequestResponse) => response.json<{ code: string; detail: string }>();

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
