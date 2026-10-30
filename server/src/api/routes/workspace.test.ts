import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LightMyRequestResponse } from 'fastify';
import { apiFixture, ifMatch, TASK_ROUTES, WS } from '../../testing/api.js';
import { skipWithoutDatabase } from '../../testing/database.js';

interface Problem {
  code: string;
  detail: string;
  errors?: { path: string; code: string }[];
}
interface Project {
  id: string;
  name: string;
  version: number;
  stores: { storeId: string; slot: number }[];
  referenceIds: string[];
  memberIds: string[];
  milestones: { id: string; name: string }[];
  favourite: boolean;
}
type List<T = Record<string, unknown>> = { items: T[]; nextCursor: string | null };
const W = `/w/${WS}`;
const code = (response: LightMyRequestResponse) => response.json<Problem>().code;

test('me, workspaces, members, teams, projects, activity, views, search and sync', async t => {
  if (skipWithoutDatabase(t)) return;
  const f = await apiFixture(t);

  await t.test('/me: profile, permissions per workspace, prefs at their version, sessions', async () => {
    const viewer = await f.call('viewer', 'GET', '/me');
    const me = viewer.json<{ user: { email: string }; workspaces: { slug: string }[]; permissions: Record<string, Record<string, unknown>> }>();
    assert.equal(me.user.email, 'viewer@example.test');
    assert.deepEqual(
      me.workspaces.map(w => w.slug),
      [WS],
    );
    assert.equal(me.permissions[WS]?.export, false);
    assert.equal(
      (await f.call('manager', 'GET', '/me')).json<{ permissions: Record<string, { manageLaunches: boolean }> }>().permissions[WS]?.manageLaunches,
      true,
    );

    const saved = await f.call('viewer', 'PATCH', '/me', { body: { prefs: { theme: 'dark', density: 'compact' } }, headers: ifMatch(viewer) });
    assert.equal(saved.statusCode, 200);
    const merged = await f.call('viewer', 'PATCH', '/me', { body: { prefs: { density: null } }, headers: ifMatch(saved) });
    assert.deepEqual(merged.json<{ prefs: unknown }>().prefs, { theme: 'dark' });
    assert.equal(code(await f.call('viewer', 'PATCH', '/me', { body: { prefs: {} }, headers: ifMatch(viewer) })), 'version_conflict');

    const other = await f.session(f.users.viewer.id);
    const sessions = (await f.call('viewer', 'GET', '/me/sessions')).json<List<{ id: string; current: boolean }>>();
    assert.equal(sessions.items.length, 2);
    const elsewhere = sessions.items.find(s => !s.current);
    assert.equal((await f.call('viewer', 'DELETE', `/me/sessions/${elsewhere?.id ?? ''}`)).statusCode, 204);
    assert.equal(code(await f.call(null, 'GET', '/me', { headers: { cookie: other } })), 'session_expired');
  });

  await t.test('workspaces: listed to their members; created by admins with the seed teams; settings at their version', async () => {
    assert.deepEqual((await f.call('outsider', 'GET', '/workspaces')).json<List>().items, []);
    assert.equal((await f.call('manager', 'POST', '/workspaces', { body: { slug: 'other', name: 'Other' } })).statusCode, 403);
    const created = await f.call('admin', 'POST', '/workspaces', { body: { slug: 'second-ws', name: 'Second' } });
    assert.equal(created.statusCode, 201);
    const teams = (await f.call('admin', 'GET', '/w/second-ws/teams')).json<List<{ key: string }>>();
    assert.deepEqual(teams.items.map(team => team.key).sort(), ['brand', 'commercial', 'comms', 'marketing', 'registration', 'supply', 'vm']);
    assert.equal((await f.call('admin', 'GET', '/workspaces')).json<List>().items.length, 2);

    const current = await f.call('viewer', 'GET', W);
    const settings = { marginAccess: { roles: ['Workspace.Admin'], teams: [] } };
    assert.equal((await f.call('manager', 'PATCH', W, { body: { settings }, headers: ifMatch(current) })).statusCode, 403);
    const patched = await f.call('admin', 'PATCH', W, { body: { settings, name: 'Synthetic Retail Group' }, headers: ifMatch(current) });
    assert.equal(patched.json<{ name: string }>().name, 'Synthetic Retail Group');
    assert.equal(code(await f.call('admin', 'PATCH', W, { body: { name: 'Late' }, headers: ifMatch(current) })), 'version_conflict');
    assert.equal((await f.call('manager', 'GET', '/me')).json<{ permissions: Record<string, { margins: boolean }> }>().permissions[WS]?.margins, false);
  });

  await t.test('members: invited by e-mail, roles changed at their version, never without an Owner', async () => {
    const members = (await f.call('viewer', 'GET', `${W}/members?team=vm`)).json<List<{ user: { email: string } }>>();
    assert.deepEqual(
      members.items.map(m => m.user.email),
      ['vm@example.test'],
    );
    assert.equal((await f.call('viewer', 'GET', `${W}/members?q=manager`)).json<List>().items.length, 1);

    const invited = await f.call('admin', 'POST', `${W}/members`, { body: { email: 'new.person@example.test', gr8rRole: 'Guest' } });
    assert.equal(invited.statusCode, 201);
    const person = invited.json<{ user: { id: string; status: string }; gr8rRole: string }>();
    assert.deepEqual([person.user.status, person.gr8rRole], ['invited', 'Guest']);
    assert.equal(code(await f.call('admin', 'POST', `${W}/members`, { body: { email: 'new.person@example.test' } })), 'duplicate');

    const promoted = await f.call('admin', 'PATCH', `${W}/members/${person.user.id}`, { body: { gr8rRole: 'Member' }, headers: ifMatch(invited) });
    assert.equal(promoted.json<{ gr8rRole: string }>().gr8rRole, 'Member');
    const owner = (await f.call('admin', 'GET', `${W}/members`))
      .json<List<{ user: { id: string }; version: number; gr8rRole: string }>>()
      .items.find(m => m.gr8rRole === 'Owner');
    const demoted = await f.call('admin', 'PATCH', `${W}/members/${owner?.user.id ?? ''}`, {
      body: { gr8rRole: 'Member' },
      headers: { 'if-match': `"${String(owner?.version)}"` },
    });
    assert.equal(demoted.statusCode, 422);
    assert.match(demoted.json<Problem>().detail, /needs an Owner/);
    assert.equal((await f.call('admin', 'DELETE', `${W}/members/${person.user.id}`, { headers: ifMatch(promoted) })).statusCode, 204);
    assert.equal((await f.call('admin', 'GET', `${W}/members?q=new.person`)).json<List>().items.length, 0);
  });

  await t.test('teams: Entra memberships are changed in Entra, manual ones here', async () => {
    const created = await f.call('admin', 'POST', `${W}/teams`, { body: { key: 'visual', name: 'Visual' } });
    const team = created.json<{ id: string }>();
    const renamed = await f.call('admin', 'PATCH', `${W}/teams/${team.id}`, { body: { name: 'Visual merchandising' }, headers: ifMatch(created) });
    assert.equal(renamed.json<{ name: string }>().name, 'Visual merchandising');
    assert.equal((await f.call('admin', 'PUT', `${W}/teams/${team.id}/members/${f.users.comms.id}`)).statusCode, 204);
    const read = await f.call('viewer', 'GET', `${W}/teams/${team.id}`);
    assert.deepEqual(read.json<{ members: unknown[] }>().members, [{ userId: f.users.comms.id, source: 'manual' }]);
    assert.equal((await f.call('admin', 'DELETE', `${W}/teams/${team.id}/members/${f.users.comms.id}`)).statusCode, 204);
    const entra = await f.call('admin', 'DELETE', `${W}/teams/${f.teams.vm}/members/${f.users.vm.id}`);
    assert.equal(entra.statusCode, 409);
    assert.equal(code(entra), 'managed_by_entra');
    assert.equal(
      (await f.call('admin', 'DELETE', `${W}/teams/${team.id}`, { headers: ifMatch(await f.call('viewer', 'GET', `${W}/teams/${team.id}`)) })).statusCode,
      204,
    );
  });

  let launch: Project;
  let plain: Project;
  await t.test('projects: launches by managers with a template and market; private ones only for their members', async () => {
    assert.deepEqual(
      (await f.call('manager', 'POST', `${W}/projects`, { body: { name: 'L', key: 'LL', kind: 'launch' } })).json<Problem>().errors?.map(e => e.path),
      ['templateId', 'marketCode'],
    );
    const launchBody = { name: 'Synthetic launch', key: 'LCH', kind: 'launch', templateId: f.templateId, marketCode: 'QAT' };
    assert.equal((await f.call('brand', 'POST', `${W}/projects`, { body: launchBody })).statusCode, 403);
    launch = (
      await f.call('manager', 'POST', `${W}/projects`, {
        body: {
          ...launchBody,
          stores: [
            { storeId: f.stores.DFC, slot: 1 },
            { storeId: f.stores.VLG, slot: 2 },
          ],
        },
      })
    ).json<Project>();
    plain = (await f.call('brand', 'POST', `${W}/projects`, { body: { name: 'Private plans', key: 'PRV', kind: 'general', private: true } })).json<Project>();
    assert.equal((await f.call('viewer', 'GET', `${W}/projects/${plain.id}`)).statusCode, 404);
    assert.equal((await f.call('admin', 'GET', `${W}/projects/${plain.id}`)).statusCode, 200);
    const all = (await f.call('viewer', 'GET', `${W}/projects?limit=1`)).json<List<Project>>();
    assert.deepEqual(
      all.items.map(p => p.name),
      ['Synthetic launch'],
    );
    assert.equal(all.nextCursor, null, 'the private project is not counted either');
    assert.equal((await f.call('brand', 'GET', `${W}/projects?kind=general`)).json<List>().items.length, 1);

    const current = await f.call('brand', 'GET', `${W}/projects/${plain.id}`);
    const renamed = await f.call('brand', 'PATCH', `${W}/projects/${plain.id}`, { body: { name: 'Private plans 2' }, headers: ifMatch(current) });
    assert.equal(renamed.json<Project>().version, 2);
    assert.equal(code(await f.call('brand', 'PATCH', `${W}/projects/${plain.id}`, { body: { name: 'Stale' }, headers: ifMatch(current) })), 'version_conflict');
    const members = await f.call('manager', 'PUT', `${W}/projects/${plain.id}/members`, {
      body: { memberIds: [f.users.brand.id, f.users.viewer.id] },
      headers: ifMatch(renamed),
    });
    assert.equal(members.statusCode, 404, 'the manager is not a member of the private project either');
    const added = await f.call('admin', 'PUT', `${W}/projects/${plain.id}/members`, {
      body: { memberIds: [f.users.brand.id, f.users.viewer.id] },
      headers: ifMatch(renamed),
    });
    assert.equal(added.statusCode, 200);
    assert.equal((await f.call('viewer', 'GET', `${W}/projects/${plain.id}`)).statusCode, 200);
  });

  await t.test('a launch store with answers is removed only with force; references and milestones', async () => {
    const line = (await f.call('manager', 'POST', `${W}/tasks`, { body: { projectId: launch.id, kind: 'line', title: 'Line', brandId: f.brandId } })).json<{
      id: string;
    }>();
    await f.db.query(`update line_store set values = '{"vm_dressed": true}' where task_id = $1 and store_id = $2`, [line.id, f.stores.VLG]);
    let current = await f.call('manager', 'GET', `${W}/projects/${launch.id}`);
    const onlyDfc = { stores: [{ storeId: f.stores.DFC, slot: 1 }] };
    const refused = await f.call('manager', 'PUT', `${W}/projects/${launch.id}/stores`, { body: onlyDfc, headers: ifMatch(current) });
    assert.equal(refused.statusCode, 422);
    assert.match(refused.json<Problem>().detail, /force=true/);
    current = await f.call('manager', 'PUT', `${W}/projects/${launch.id}/stores?force=true`, { body: onlyDfc, headers: ifMatch(current) });
    assert.deepEqual(current.json<Project>().stores, onlyDfc.stores);

    const reference = (await f.call('manager', 'POST', `${W}/projects`, { body: { name: 'Earlier launch', key: 'OLD', kind: 'general' } })).json<Project>();
    current = await f.call('manager', 'PUT', `${W}/projects/${launch.id}/references`, { body: { referenceIds: [reference.id] }, headers: ifMatch(current) });
    assert.deepEqual(current.json<Project>().referenceIds, [reference.id]);
    const self = await f.call('manager', 'PUT', `${W}/projects/${launch.id}/references`, { body: { referenceIds: [launch.id] }, headers: ifMatch(current) });
    assert.equal(self.statusCode, 422);

    const milestone = await f.call('manager', 'POST', `${W}/projects/${launch.id}/milestones`, {
      body: { name: 'Store opening', date: '2026-12-01', storeId: f.stores.DFC },
    });
    assert.equal(milestone.statusCode, 201);
    const { id } = milestone.json<{ id: string }>();
    const moved = await f.call('manager', 'PATCH', `${W}/milestones/${id}`, { body: { date: '2026-12-08' }, headers: ifMatch(milestone) });
    assert.equal(moved.json<{ date: string }>().date, '2026-12-08');
    assert.deepEqual(
      (await f.call('viewer', 'GET', `${W}/projects/${launch.id}`)).json<Project>().milestones.map(m => m.name),
      ['Store opening'],
    );
    assert.equal((await f.call('manager', 'DELETE', `${W}/milestones/${id}`, { headers: ifMatch(moved) })).statusCode, 204);
    assert.equal(
      (await f.call('manager', 'DELETE', `${W}/projects/${reference.id}`, { headers: ifMatch(await f.call('viewer', 'GET', `${W}/projects/${reference.id}`)) }))
        .statusCode,
      204,
    );
  });

  await t.test('favourites and notifications belong to the caller', async () => {
    assert.equal((await f.call('viewer', 'PUT', `/me/favourites/project/${launch.id}`)).statusCode, 204);
    assert.equal((await f.call('viewer', 'GET', `${W}/projects/${launch.id}`)).json<Project>().favourite, true);
    assert.equal((await f.call('brand', 'GET', `${W}/projects/${launch.id}`)).json<Project>().favourite, false);
    assert.equal((await f.call('viewer', 'DELETE', `/me/favourites/project/${launch.id}`)).statusCode, 204);
    assert.equal((await f.call('viewer', 'GET', `${W}/projects/${launch.id}`)).json<Project>().favourite, false);

    for (const title of ['One', 'Two']) await f.call('manager', 'POST', `${W}/tasks`, { body: { projectId: launch.id, title, assigneeId: f.users.comms.id } });
    const inbox = (await f.call('comms', 'GET', `/me/notifications?ws=${WS}&type=assign`)).json<List<{ id: string; version: number; readAt: string | null }>>();
    assert.equal(inbox.items.length, 2);
    const first = inbox.items[0];
    const read = await f.call('comms', 'PATCH', `/me/notifications/${first?.id ?? ''}`, {
      body: { read: true },
      headers: { 'if-match': `"${String(first?.version)}"` },
    });
    assert.ok(read.json<{ readAt: string | null }>().readAt);
    assert.equal((await f.call('viewer', 'PATCH', `/me/notifications/${first?.id ?? ''}`, { body: { read: true }, headers: ifMatch(read) })).statusCode, 404);
    assert.deepEqual((await f.call('comms', 'POST', '/me/notifications/read-all', { body: { ws: WS } })).json(), { updated: 1 });
    assert.deepEqual((await f.call('comms', 'GET', '/me/notifications?filter=unread')).json<List>().items, []);
  });

  await t.test('activity is newest first, filtered, and hides margin and contact changes from those who may not see them', async () => {
    const activity = (await f.call('viewer', 'GET', `${W}/activity?projectId=${launch.id}&limit=2`)).json<List<{ verb: string; entityKind: string }>>();
    assert.equal(activity.items.length, 2);
    assert.ok(activity.nextCursor);
    const older = (await f.call('viewer', 'GET', `${W}/activity?projectId=${launch.id}&cursor=${activity.nextCursor}`)).json<List>();
    assert.ok(older.items.length > 0);
    assert.equal(
      (await f.call('viewer', 'GET', `${W}/activity?projectId=${plain.id}`)).json<List>().items.length > 0,
      true,
      'a member sees the private project',
    );
    assert.equal((await f.call('comms', 'GET', `${W}/activity?projectId=${plain.id}`)).json<List>().items.length, 0);

    await f.db.query(
      `insert into activity (workspace_id, project_id, actor_id, verb, entity_kind, changes, sensitivity)
       values ($1, $2, $3, 'updated', 'brand_market', '[{"field":"margin","from":0.1,"to":0.2}]', 'margin')`,
      [f.workspaceId, launch.id, f.users.admin.id],
    );
    const seen = (user: 'admin' | 'viewer') =>
      f.call(user, 'GET', `${W}/activity?actorId=${f.users.admin.id}&limit=1`).then(r => r.json<List<{ redacted?: boolean; changes?: unknown }>>().items[0]);
    assert.deepEqual((await seen('admin'))?.changes, [{ field: 'margin', from: 0.1, to: 0.2 }]);
    assert.equal((await seen('viewer'))?.redacted, true);
    assert.equal((await seen('viewer'))?.changes, undefined);
  });

  await t.test('saved views: own ones by their owner, shared ones by managers', async () => {
    const own = await f.call('viewer', 'POST', `${W}/views`, { body: { name: 'My board', type: 'board', config: { group: 'status' }, projectId: launch.id } });
    assert.equal(own.statusCode, 201);
    assert.equal((await f.call('brand', 'POST', `${W}/views`, { body: { name: 'Shared', type: 'table', ownerId: null } })).statusCode, 403);
    const shared = await f.call('manager', 'POST', `${W}/views`, { body: { name: 'Shared', type: 'table', ownerId: null } });
    assert.equal(shared.statusCode, 201);
    assert.equal((await f.call('viewer', 'POST', `${W}/views`, { body: { name: 'X', type: 'list', projectId: plain.id } })).statusCode, 201);
    assert.equal(
      (await f.call('comms', 'POST', `${W}/views`, { body: { name: 'X', type: 'list', projectId: plain.id } })).json<Problem>().errors?.[0]?.code,
      'unknown_ref',
    );
    const ownId = own.json<{ id: string }>().id;
    assert.equal((await f.call('brand', 'PATCH', `${W}/views/${ownId}`, { body: { name: 'Mine' }, headers: ifMatch(own) })).statusCode, 403);
    const renamed = await f.call('viewer', 'PATCH', `${W}/views/${ownId}`, { body: { name: 'Board' }, headers: ifMatch(own) });
    assert.equal(renamed.json<{ name: string }>().name, 'Board');
    assert.deepEqual(
      (await f.call('brand', 'GET', `${W}/views`)).json<List<{ name: string }>>().items.map(v => v.name),
      ['Shared'],
    );
    assert.deepEqual(
      (await f.call('viewer', 'GET', `${W}/views?projectId=${launch.id}`)).json<List<{ name: string }>>().items.map(v => v.name),
      ['Board'],
    );
    assert.equal((await f.call('viewer', 'DELETE', `${W}/views/${ownId}`, { headers: ifMatch(renamed) })).statusCode, 204);
  });

  await t.test('search finds what the caller may see, by category', async () => {
    const all = (await f.call('comms', 'GET', `${W}/search?q=${encodeURIComponent('synthetic')}`)).json<Record<string, { name?: string; title?: string }[]>>();
    assert.deepEqual(
      all.projects?.map(p => p.name),
      ['Synthetic launch'],
    );
    assert.deepEqual((await f.call('comms', 'GET', `${W}/search?q=northwind&cat=brands`)).json<Record<string, unknown[]>>().brands?.length, 1);
    assert.deepEqual((await f.call('comms', 'GET', `${W}/search?q=private`)).json<Record<string, unknown[]>>().projects, []);
    assert.equal((await f.call('viewer', 'GET', `${W}/search?q=private`)).json<Record<string, unknown[]>>().projects?.length, 1);
    assert.equal(
      (await f.call('viewer', 'GET', `${W}/search?q=${encodeURIComponent('%')}`)).json<Record<string, unknown[]>>().projects?.length,
      0,
      '% is literal',
    );
  });

  await t.test('bootstrap holds the visible workspace; /changes carries every later change and tombstone', async () => {
    const boot = (await f.call('comms', 'GET', `${W}/bootstrap`)).json<{
      changeSeq: number;
      workspace: { slug: string };
      projects: { id: string }[];
      tasks: unknown[];
      stores: unknown[];
      markets: unknown[];
    }>();
    assert.equal(boot.workspace.slug, WS);
    assert.ok(!boot.projects.some(p => p.id === plain.id), 'no private project of others');
    assert.equal(boot.stores.length, 2);
    assert.equal(boot.markets.length, 6);

    const project = await f.call('manager', 'GET', `${W}/projects/${launch.id}`);
    await f.call('manager', 'PATCH', `${W}/projects/${launch.id}`, { body: { status: 'active' }, headers: ifMatch(project) });
    const views = (await f.call('manager', 'GET', `${W}/views`)).json<List<{ id: string; version: number }>>();
    const shared = views.items[0];
    await f.call('manager', 'DELETE', `${W}/views/${shared?.id ?? ''}`, { headers: { 'if-match': `"${String(shared?.version)}"` } });
    await f.call('brand', 'PATCH', `${W}/projects/${plain.id}`, {
      body: { status: 'risk' },
      headers: ifMatch(await f.call('brand', 'GET', `${W}/projects/${plain.id}`)),
    });

    type Changes = {
      items: { kind: string; id: string; deleted: boolean; changeSeq: number; data: { status?: string } | null }[];
      nextSince: number;
      hasMore: boolean;
    };
    const changes = (await f.call('comms', 'GET', `${W}/changes?since=${String(boot.changeSeq)}`)).json<Changes>();
    assert.equal(changes.hasMore, false);
    assert.deepEqual(
      changes.items.map(item => [item.kind, item.id, item.deleted]),
      [
        ['project', launch.id, false],
        ['savedView', shared?.id, true],
      ],
      'nothing from the private project',
    );
    assert.equal(changes.items[0]?.data?.status, 'active');
    assert.equal(changes.items[1]?.data, null);

    const first = (await f.call('comms', 'GET', `${W}/changes?since=${String(boot.changeSeq)}&limit=1`)).json<Changes>();
    assert.equal(first.hasMore, true);
    const rest = (await f.call('comms', 'GET', `${W}/changes?since=${String(first.nextSince)}`)).json<Changes>();
    assert.deepEqual(
      [...first.items, ...rest.items].map(item => item.id),
      changes.items.map(item => item.id),
    );
    assert.deepEqual((await f.call('comms', 'GET', `${W}/changes?since=${String(changes.nextSince)}`)).json<Changes>().items, []);
  });

  await t.test('every other route has a test', () => {
    f.assertCovered(['/me', '/workspaces', '/w/:ws'], TASK_ROUTES);
  });
});
