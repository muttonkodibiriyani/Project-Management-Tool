import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type pg from 'pg';
import { migrate } from '../db/migrate.js';
import { APP_ROLE_PASSWORD, emptyDatabase, skipWithoutDatabase } from '../testing/database.js';
import { DEV_USERS } from './dev-users.js';
import { SignInError } from './entra.js';
import { hashToken, postgresSessions, SESSION_HOURS, type Identity } from './sessions.js';

const VISITOR = { userAgent: 'synthetic-browser', ip: '192.0.2.10' };
const lily: Identity = {
  oid: '44444444-4444-4444-8444-444444444444',
  tenantId: '11111111-1111-4111-8111-111111111111',
  email: 'lily@corp.example',
  name: 'Lily Synthetic',
  roles: ['BrandTeam', 'Supply'],
};

/** A migrated database, written to as lt_app (the app's own role), and an admin client to look at it. */
async function setUp(t: TestContext) {
  const database = await emptyDatabase(t);
  const admin = await database.connect();
  await migrate(admin, () => undefined);
  const app = await database.connect('lt_app', APP_ROLE_PASSWORD);
  const sessions = postgresSessions({ connect: () => Promise.resolve(Object.assign(app, { release: () => undefined })) });
  return { admin, sessions };
}

async function workspaceWithTeams(admin: pg.Client) {
  const { rows } = await admin.query<{ id: string }>(`insert into workspace (slug, name) values ('qa', 'Synthetic workspace') returning id`);
  const workspace = rows[0]?.id;
  await admin.query(
    `insert into team (workspace_id, key, name, app_role) values
       ($1, 'brand', 'Brand', 'BrandTeam'), ($1, 'supply', 'Supply', 'Supply'), ($1, 'vm', 'VM', 'VM'),
       ($1, 'comms', 'Comms', 'Comms'), ($1, 'commercial', 'Commercial', null)`,
    [workspace],
  );
  return workspace;
}

const teamsOf = async (admin: pg.Client, email: string) =>
  (
    await admin.query<{ key: string; source: string }>(
      `select t.key, m.source from team_member m join team t on t.id = m.team_id join app_user u on u.id = m.user_id
       where u.email = $1 order by t.key`,
      [email],
    )
  ).rows.map(row => `${row.key}:${row.source}`);

test('sign-in adds the user and a 12-hour session that holds only the token hash', async t => {
  if (skipWithoutDatabase(t)) return;
  const { admin, sessions } = await setUp(t);
  const { token, expiresAt } = await sessions.start(lily, VISITOR);

  const user = (await admin.query(`select * from app_user`)).rows[0] as Record<string, unknown>;
  assert.equal(user.entra_oid, lily.oid);
  assert.equal(user.tenant_id, lily.tenantId);
  assert.equal(user.email, lily.email);
  assert.deepEqual(user.app_roles, ['BrandTeam', 'Supply']);
  assert.equal(user.status, 'active');

  const session = (await admin.query(`select *, extract(epoch from expires_at - created_at) as seconds from user_session`)).rows[0] as Record<string, unknown>;
  assert.deepEqual(session.token_hash, hashToken(token));
  assert.equal(Number(session.seconds), SESSION_HOURS * 3600);
  assert.deepEqual([session.user_agent, session.ip, session.revoked_at], ['synthetic-browser', '192.0.2.10', null]);
  assert.equal((session.expires_at as Date).getTime(), expiresAt.getTime());
  assert.ok(!JSON.stringify((await admin.query(`select * from user_session`)).rows).includes(token), 'the token itself is stored nowhere');
});

test('each sign-in refreshes roles and e-mail, keeps a name changed in the app, and starts a new session', async t => {
  if (skipWithoutDatabase(t)) return;
  const { admin, sessions } = await setUp(t);
  const first = await sessions.start(lily, VISITOR);
  await admin.query(`update app_user set name = 'Lily (Brand)'`);
  const second = await sessions.start({ ...lily, email: 'lily.s@corp.example', name: 'Ignored', roles: ['Viewer'] }, VISITOR);

  assert.notEqual(first.token, second.token);
  const users = (await admin.query<{ email: string; name: string; app_roles: string[] }>(`select email, name, app_roles from app_user`)).rows;
  assert.deepEqual(users, [{ email: 'lily.s@corp.example', name: 'Lily (Brand)', app_roles: ['Viewer'] }]);
  assert.equal((await admin.query(`select 1 from user_session`)).rowCount, 2);
});

test('sign-in claims a pending invite with the same e-mail', async t => {
  if (skipWithoutDatabase(t)) return;
  const { admin, sessions } = await setUp(t);
  const workspace = await workspaceWithTeams(admin);
  const invited = (
    await admin.query<{ id: string }>(`insert into app_user (email, name, status) values ('LILY@corp.example', 'Invited Lily', 'invited') returning id`)
  ).rows[0]?.id;
  await admin.query(`insert into workspace_member (workspace_id, user_id) values ($1, $2)`, [workspace, invited]);

  await sessions.start(lily, VISITOR);
  const users = (await admin.query<{ id: string; entra_oid: string; status: string }>(`select id, entra_oid, status from app_user`)).rows;
  assert.deepEqual(users, [{ id: invited, entra_oid: lily.oid, status: 'active' }], 'the invite became the account, keeping its membership');
});

test('Entra teams follow the roles at each sign-in, and manual teams stay', async t => {
  if (skipWithoutDatabase(t)) return;
  const { admin, sessions } = await setUp(t);
  await workspaceWithTeams(admin);
  await sessions.start(lily, VISITOR);
  assert.deepEqual(await teamsOf(admin, lily.email), ['brand:entra', 'supply:entra']);

  await admin.query(
    `insert into team_member (team_id, user_id, source)
     select t.id, u.id, 'manual' from team t, app_user u where t.key in ('commercial', 'vm')`,
  );
  await sessions.start({ ...lily, roles: ['Supply'] }, VISITOR);
  assert.deepEqual(await teamsOf(admin, lily.email), ['commercial:manual', 'supply:entra', 'vm:manual']);

  await admin.query(`update team set deleted_at = now() where key = 'supply'`);
  await sessions.start({ ...lily, roles: ['Supply', 'VM'] }, VISITOR);
  assert.deepEqual(await teamsOf(admin, lily.email), ['commercial:manual', 'vm:manual'], 'no Entra membership of a deleted team; manual vm kept');
});

test('a turned-off account and a clashing e-mail are refused without writing a session', async t => {
  if (skipWithoutDatabase(t)) return;
  const { admin, sessions } = await setUp(t);
  await sessions.start(lily, VISITOR);
  await admin.query(`update app_user set status = 'disabled'`);
  await assert.rejects(sessions.start(lily, VISITOR), (error: unknown) => error instanceof SignInError && error.code === 'account_disabled');

  const other = { ...lily, oid: '55555555-5555-4555-8555-555555555555' };
  await assert.rejects(sessions.start(other, VISITOR), (error: unknown) => error instanceof SignInError && error.code === 'account_conflict');
  assert.equal((await admin.query(`select 1 from user_session`)).rowCount, 1, 'only the first sign-in wrote a session');
  assert.equal((await admin.query(`select 1 from app_user`)).rowCount, 1);
});

test('sign-out revokes only that session', async t => {
  if (skipWithoutDatabase(t)) return;
  const { admin, sessions } = await setUp(t);
  const phone = await sessions.start(lily, VISITOR);
  const laptop = await sessions.start(lily, VISITOR);
  await sessions.end(phone.token);
  await sessions.end(phone.token);
  await sessions.end('not-a-session');

  const rows = (await admin.query<{ token_hash: Buffer; revoked: boolean }>(`select token_hash, revoked_at is not null as revoked from user_session`)).rows;
  const revoked = (token: string) => rows.find(row => row.token_hash.equals(hashToken(token)))?.revoked;
  assert.equal(revoked(phone.token), true);
  assert.equal(revoked(laptop.token), false);
});

test('every test user signs in through the same writer', async t => {
  if (skipWithoutDatabase(t)) return;
  const { admin, sessions } = await setUp(t);
  await workspaceWithTeams(admin);
  for (const user of DEV_USERS) await sessions.start(user, VISITOR);
  const users = (await admin.query<{ email: string; app_roles: string[] }>(`select email, app_roles from app_user order by email`)).rows;
  assert.equal(users.length, DEV_USERS.length);
  assert.deepEqual(await teamsOf(admin, 'vm@example.test'), ['vm:entra']);
  assert.deepEqual(await teamsOf(admin, 'viewer@example.test'), []);
});
