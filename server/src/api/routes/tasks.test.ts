import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiFixture, ifMatch, TASK_ROUTES, WS } from '../../testing/api.js';
import { skipWithoutDatabase } from '../../testing/database.js';

interface Task {
  id: string;
  key: string;
  kind: string;
  title: string;
  version: number;
  status: string;
  values: Record<string, unknown>;
  subtasks: { id: string; title: string; version: number }[];
  dependencyIds: string[];
  doubleOfId: string | null;
  followsUpId: string | null;
  commentCount: number;
  openFollowUps: { total: number; byGate: Record<string, number> };
  lineStores?: { storeId: string }[];
}
interface Problem {
  code: string;
  detail: string;
  errors?: { path: string; code: string }[];
  current?: Task;
}
const W = `/w/${WS}`;

test('tasks, launch lines, follow-ups, subtasks and dependencies', async t => {
  if (skipWithoutDatabase(t)) return;
  const f = await apiFixture(t);
  const launch = (
    await f.call('manager', 'POST', `${W}/projects`, {
      body: {
        name: 'Synthetic launch',
        key: 'LCH',
        kind: 'launch',
        templateId: f.templateId,
        marketCode: 'QAT',
        stores: [
          { storeId: f.stores.DFC, slot: 1 },
          { storeId: f.stores.VLG, slot: 2 },
        ],
      },
    })
  ).json<{ id: string }>();
  const general = (await f.call('brand', 'POST', `${W}/projects`, { body: { name: 'Synthetic tasks', key: 'GEN', kind: 'general' } })).json<{ id: string }>();
  const newLine = async (values: Record<string, unknown> = {}) =>
    (
      await f.call('manager', 'POST', `${W}/tasks`, { body: { projectId: launch.id, kind: 'line', title: 'Synthetic line', brandId: f.brandId, values } })
    ).json<Task>();
  const read = (id: string) => f.call('viewer', 'GET', `${W}/tasks/${id}`);

  let line: Task;
  await t.test('a launch line gets the next key, a row per store and its brand × market row', async () => {
    const response = await f.call('manager', 'POST', `${W}/tasks`, {
      body: { projectId: launch.id, kind: 'line', title: 'Synthetic line', brandId: f.brandId, values: { zone: 'A1', channel: 'retail' } },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.headers.etag, '"1"');
    line = response.json<Task>();
    assert.equal(line.key, 'LCH-001');
    assert.deepEqual(line.values, { zone: 'A1', channel: 'retail' });
    assert.equal(response.headers.location, `/api/v1${W}/tasks/${line.id}`);
    const stores = (await f.call('viewer', 'GET', `${W}/tasks/${line.id}/stores`)).json<{ items: { storeId: string }[] }>();
    assert.deepEqual(stores.items.map(store => store.storeId).sort(), [f.stores.DFC, f.stores.VLG].sort());
    assert.equal((await f.db.query(`select 1 from brand_market where brand_id = $1 and market_code = 'QAT'`, [f.brandId])).rowCount, 1);
  });

  await t.test('only managers create lines, and a line needs a brand and current options', async () => {
    const asBrand = await f.call('brand', 'POST', `${W}/tasks`, { body: { projectId: launch.id, kind: 'line', title: 'X', brandId: f.brandId } });
    assert.equal(asBrand.statusCode, 403);
    const noBrand = await f.call('manager', 'POST', `${W}/tasks`, { body: { projectId: launch.id, kind: 'line', title: 'X' } });
    assert.deepEqual(
      noBrand.json<Problem>().errors?.map(error => error.path),
      ['brandId'],
    );
    const archived = await f.call('manager', 'POST', `${W}/tasks`, {
      body: { projectId: launch.id, kind: 'line', title: 'X', brandId: f.brandId, values: { channel: 'kiosk', nope: 1 } },
    });
    assert.equal(archived.statusCode, 422);
    assert.deepEqual(
      archived
        .json<Problem>()
        .errors?.map(error => error.code)
        .sort(),
      ['archived_option', 'unknown_field'],
    );
    const lines = await f.db.query(`select 1 from task where kind = 'line'`);
    assert.equal(lines.rowCount, 1, 'nothing refused was written');
  });

  await t.test('a stale edit is refused with a plain message and the current task, and nothing is written', async () => {
    const first = await f.call('manager', 'PATCH', `${W}/tasks/${line.id}`, { body: { title: 'Renamed by the manager' }, headers: { 'if-match': '"1"' } });
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers.etag, '"2"');

    const stale = await f.call('admin', 'PATCH', `${W}/tasks/${line.id}`, { body: { title: 'Renamed by the admin' }, headers: { 'if-match': '"1"' } });
    assert.equal(stale.statusCode, 409);
    const problem = stale.json<Problem>();
    assert.equal(problem.code, 'version_conflict');
    assert.equal(problem.detail, 'Someone else changed this first (now version 2). Compare your change with theirs, then send it again with If-Match: "2".');
    assert.equal(problem.current?.title, 'Renamed by the manager');
    assert.equal(problem.current.version, 2);
    assert.equal((await read(line.id)).json<Task>().title, 'Renamed by the manager');

    const blind = await f.call('admin', 'PATCH', `${W}/tasks/${line.id}`, { body: { title: 'Blind' } });
    assert.equal(blind.statusCode, 428);
    assert.equal(blind.json<Problem>().code, 'version_required');
  });

  await t.test('values are merge-patched, and each gate is edited only by its owner team', async () => {
    let current = await read(line.id);
    const bySupply = await f.call('supply', 'PATCH', `${W}/tasks/${line.id}`, {
      body: { values: { supply_ready: true, zone: null } },
      headers: ifMatch(current),
    });
    assert.equal(bySupply.statusCode, 403, 'zone is not a gate, and Supply does not edit this line');
    assert.equal(bySupply.json<Problem>().code, 'field_forbidden');
    assert.deepEqual(
      bySupply.json<Problem>().errors?.map(error => error.path),
      ['values.zone'],
    );

    const gate = await f.call('supply', 'PATCH', `${W}/tasks/${line.id}`, { body: { values: { supply_ready: true } }, headers: ifMatch(current) });
    assert.equal(gate.statusCode, 200);
    current = gate;
    const title = await f.call('supply', 'PATCH', `${W}/tasks/${line.id}`, { body: { title: 'Mine now' }, headers: ifMatch(current) });
    assert.equal(title.json<Problem>().code, 'field_forbidden');
    const vm = await f.call('vm', 'PATCH', `${W}/tasks/${line.id}`, { body: { values: { supply_ready: false } }, headers: ifMatch(current) });
    assert.match(vm.json<Problem>().detail, /values\.supply_ready/);

    const merged = await f.call('manager', 'PATCH', `${W}/tasks/${line.id}`, { body: { values: { zone: null } }, headers: ifMatch(current) });
    assert.deepEqual(merged.json<Task>().values, { channel: 'retail', supply_ready: true });

    const activity = (await f.call('viewer', 'GET', `${W}/activity?taskId=${line.id}`)).json<{
      items: { verb: string; changes: { field: string; from: unknown; to: unknown }[] }[];
    }>();
    assert.deepEqual(activity.items[0]?.changes, [{ field: 'values.zone', from: 'A1', to: null }]);
    assert.deepEqual(
      activity.items.map(entry => entry.verb),
      ['updated', 'updated', 'updated', 'created'],
    );
  });

  let task: Task;
  await t.test('tasks: assignee notified, refs checked, Idempotency-Key replays the first answer', async () => {
    const headers = { 'idempotency-key': 'synthetic-key-0001' };
    const request = { projectId: general.id, title: 'Order shelf labels', assigneeId: f.users.viewer.id };
    const first = await f.call('brand', 'POST', `${W}/tasks`, { body: request, headers });
    assert.equal(first.statusCode, 201);
    task = first.json<Task>();
    assert.equal(task.key, 'GEN-001');
    const again = await f.call('brand', 'POST', `${W}/tasks`, { body: request, headers });
    assert.equal(again.json<Task>().id, task.id);
    assert.equal((await f.db.query(`select 1 from task where project_id = $1`, [general.id])).rowCount, 1);
    const reused = await f.call('brand', 'POST', `${W}/tasks`, { body: { ...request, title: 'Other' }, headers });
    assert.equal(reused.json<Problem>().code, 'idempotency_key_reused');

    const inbox = (await f.call('viewer', 'GET', '/me/notifications')).json<{ items: { type: string; text: string }[] }>();
    assert.deepEqual(
      inbox.items.map(n => [n.type, n.text]),
      [['assign', 'Test brand assigned you GEN-001: Order shelf labels']],
    );
    const outsider = await f.call('brand', 'POST', `${W}/tasks`, { body: { projectId: general.id, title: 'X', assigneeId: f.users.outsider.id } });
    assert.deepEqual(
      outsider.json<Problem>().errors?.map(error => error.code),
      ['unknown_ref'],
    );
  });

  await t.test('the list filters, sorts, searches, includes and pages', async () => {
    const list = async (query: string) => {
      const response = await f.call('viewer', 'GET', `${W}/tasks?${query}`);
      assert.equal(response.statusCode, 200, query);
      return response.json<{ items: Task[]; nextCursor: string | null }>();
    };
    assert.deepEqual(
      (await list(`projectId=${launch.id}&filter[values.channel]=retail`)).items.map(x => x.key),
      ['LCH-001'],
    );
    assert.deepEqual(
      (await list(`filter[assigneeId]=${f.users.viewer.id}&filter[kind]=task`)).items.map(x => x.key),
      ['GEN-001'],
    );
    assert.deepEqual(
      (await list('q=shelf')).items.map(x => x.key),
      ['GEN-001'],
    );
    assert.deepEqual(
      (await list('sort=title')).items.map(x => x.key),
      ['GEN-001', 'LCH-001'],
    );
    const page = await list('limit=1&sort=key');
    assert.equal(page.items.length, 1);
    assert.deepEqual(
      (await list(`limit=1&sort=key&cursor=${page.nextCursor ?? ''}`)).items.map(x => x.key),
      ['LCH-001'],
    );
    const withStores = await list(`projectId=${launch.id}&include=stores`);
    assert.equal(withStores.items[0]?.lineStores?.length, 2);
    assert.equal((await f.call('viewer', 'GET', `${W}/tasks?filter[colour]=red`)).json<Problem>().code, 'bad_filter');
    assert.equal((await f.call('viewer', 'GET', `${W}/tasks/${line.id}?include=margin`)).statusCode, 400);
    assert.equal((await f.call('viewer', 'GET', `${W}/tasks?sort=colour`)).statusCode, 400);
  });

  await t.test('bulk edits one by one, or all or nothing', async () => {
    const current = (await read(task.id)).json<Task>();
    const results = await f.call('brand', 'POST', `${W}/tasks/bulk`, {
      body: {
        items: [
          { id: task.id, version: current.version, patch: { priority: 'high' } },
          { id: line.id, version: 1, patch: { priority: 'high' } },
        ],
      },
    });
    assert.deepEqual(
      results.json<{ results: { status: number }[] }>().results.map(result => result.status),
      [200, 409],
    );
    const atomic = await f.call('manager', 'POST', `${W}/tasks/bulk`, {
      body: {
        atomic: true,
        items: [
          { id: task.id, version: current.version + 1, patch: { priority: 'low' } },
          { id: line.id, version: 1, patch: { priority: 'low' } },
        ],
      },
    });
    assert.equal(atomic.statusCode, 409);
    assert.equal((await read(task.id)).json<Task>().title, 'Order shelf labels');
    assert.equal(
      (await f.db.query<{ priority: string }>(`select priority from task where id = $1`, [task.id])).rows[0]?.priority,
      'high',
      'the first item was rolled back',
    );
  });

  await t.test('subtasks are created, edited at their version and deleted', async () => {
    const created = await f.call('brand', 'POST', `${W}/tasks/${task.id}/subtasks`, { body: { title: 'Measure the bay' } });
    assert.equal(created.statusCode, 201);
    const { id } = created.json<{ id: string }>();
    const done = await f.call('brand', 'PATCH', `${W}/subtasks/${id}`, { body: { done: true }, headers: ifMatch(created) });
    assert.equal(done.json<{ done: boolean }>().done, true);
    assert.equal((await f.call('brand', 'PATCH', `${W}/subtasks/${id}`, { body: { done: false }, headers: ifMatch(created) })).statusCode, 409);
    const second = (await f.call('brand', 'POST', `${W}/tasks/${task.id}/subtasks`, { body: { title: 'Throwaway' } })).json<{ id: string }>();
    assert.equal((await f.call('brand', 'DELETE', `${W}/subtasks/${second.id}`, { headers: { 'if-match': '"1"' } })).statusCode, 204);
    assert.deepEqual(
      (await read(task.id)).json<Task>().subtasks.map(s => s.title),
      ['Measure the bay'],
    );
  });

  await t.test('duplicates copy a task with its subtasks; a line is placed again only as a DOUBLE by a manager', async () => {
    const copy = (await f.call('brand', 'POST', `${W}/tasks/${task.id}/duplicate`, { body: {} })).json<Task>();
    assert.equal(copy.title, 'Order shelf labels (copy)');
    assert.deepEqual(
      copy.subtasks.map(s => s.title),
      ['Measure the bay'],
    );
    assert.equal((await f.call('manager', 'POST', `${W}/tasks/${line.id}/duplicate`, { body: {} })).statusCode, 422);
    assert.equal((await f.call('brand', 'POST', `${W}/tasks/${line.id}/duplicate`, { body: { double: true } })).statusCode, 403);
    const double = (await f.call('manager', 'POST', `${W}/tasks/${line.id}/duplicate`, { body: { double: true, values: { zone: 'B2' } } })).json<Task>();
    assert.equal(double.doubleOfId, line.id);
    assert.equal(double.values.zone, 'B2');
    assert.equal(double.key, 'LCH-002');
  });

  await t.test('follow-ups chase a gate, per store where the gate is per store, and are counted on the line', async () => {
    const noStore = await f.call('brand', 'POST', `${W}/tasks/${line.id}/follow-ups`, { body: { title: 'Dress the window', gate: 'vm_dressed' } });
    assert.deepEqual(
      noStore.json<Problem>().errors?.map(error => error.path),
      ['storeId'],
    );
    assert.equal(
      (await f.call('brand', 'POST', `${W}/tasks/${line.id}/follow-ups`, { body: { title: 'X', gate: 'no_such_gate' } })).json<Problem>().errors?.[0]?.code,
      'unknown_field',
    );
    const raised = await f.call('brand', 'POST', `${W}/tasks/${line.id}/follow-ups`, {
      body: { title: 'Dress the window', gate: 'vm_dressed', storeId: f.stores.DFC, assigneeId: f.users.vm.id, dueDate: '2026-11-20' },
    });
    assert.equal(raised.statusCode, 201);
    assert.equal(raised.json<Task>().kind, 'follow_up');
    assert.equal(raised.json<Task>().followsUpId, line.id);
    const after = (await read(line.id)).json<Task>();
    assert.deepEqual(after.openFollowUps, { total: 1, byGate: { [`vm_dressed@${f.stores.DFC}`]: 1 } });
    assert.equal(after.commentCount, 1);
    const inbox = (await f.call('vm', 'GET', '/me/notifications')).json<{ items: { type: string }[] }>();
    assert.deepEqual(
      inbox.items.map(n => n.type),
      ['follow_up'],
      'one follow-up notice, not also an assignment',
    );

    const many = await f.call('manager', 'POST', `${W}/follow-ups`, { body: { title: 'Confirm supply', gate: 'supply_ready', lineIds: [line.id] } });
    assert.equal(many.statusCode, 201);
    assert.deepEqual(
      many.json<{ items: Task[] }>().items.map(x => x.kind),
      ['follow_up'],
    );
  });

  await t.test('line × store answers: gates per store by their owner team, new store rows by managers', async () => {
    const stores = await f.call('vm', 'GET', `${W}/tasks/${line.id}/stores`);
    const dfc = stores.json<{ items: { storeId: string; version: number }[] }>().items.find(row => row.storeId === f.stores.DFC);
    const headers = { 'if-match': `"${String(dfc?.version)}"` };
    const bySupply = await f.call('supply', 'PATCH', `${W}/tasks/${line.id}/stores/${f.stores.DFC}`, { body: { values: { vm_dressed: true } }, headers });
    assert.equal(bySupply.json<Problem>().code, 'field_forbidden');
    const byVm = await f.call('vm', 'PATCH', `${W}/tasks/${line.id}/stores/${f.stores.DFC}`, { body: { values: { vm_dressed: true } }, headers });
    assert.equal(byVm.statusCode, 200);
    assert.deepEqual(byVm.json<{ values: unknown }>().values, { vm_dressed: true });

    const { rows } = await f.db.query<{ id: string }>(
      `insert into store (workspace_id, code, name, market_code) values ($1, 'AVE', 'AVE', 'QAT') returning id`,
      [f.workspaceId],
    );
    const ave = rows[0]?.id ?? '';
    assert.equal((await f.call('brand', 'POST', `${W}/tasks/${line.id}/stores`, { body: { storeId: ave } })).statusCode, 403);
    const added = await f.call('manager', 'POST', `${W}/tasks/${line.id}/stores`, { body: { storeId: ave, values: { vm_dressed: false } } });
    assert.equal(added.statusCode, 201);
    assert.equal((await f.call('manager', 'POST', `${W}/tasks/${task.id}/stores`, { body: { storeId: ave } })).statusCode, 422);
  });

  await t.test('dependencies never loop', async () => {
    const other = (await f.call('brand', 'POST', `${W}/tasks`, { body: { projectId: general.id, title: 'Print the labels' } })).json<Task>();
    assert.equal((await f.call('brand', 'PUT', `${W}/tasks/${other.id}/dependencies/${task.id}`)).statusCode, 204);
    const loop = await f.call('brand', 'PUT', `${W}/tasks/${task.id}/dependencies/${other.id}`);
    assert.equal(loop.statusCode, 422);
    assert.match(loop.json<Problem>().detail, /loop/);
    assert.equal((await f.call('brand', 'PUT', `${W}/tasks/${task.id}/dependencies/${task.id}`)).statusCode, 422);
    assert.deepEqual((await read(other.id)).json<Task>().dependencyIds, [task.id]);
    assert.equal((await f.call('brand', 'DELETE', `${W}/tasks/${other.id}/dependencies/${task.id}`)).statusCode, 204);
    assert.deepEqual((await read(other.id)).json<Task>().dependencyIds, []);
  });

  await t.test('deletes: lines only by managers; a deleted task is gone', async () => {
    const extra = await newLine();
    assert.equal((await f.call('brand', 'DELETE', `${W}/tasks/${extra.id}`, { headers: { 'if-match': '"1"' } })).statusCode, 403);
    assert.equal((await f.call('manager', 'DELETE', `${W}/tasks/${extra.id}`, { headers: { 'if-match': '"1"' } })).statusCode, 204);
    assert.equal((await read(extra.id)).statusCode, 404);
    assert.equal((await f.call('viewer', 'DELETE', `${W}/tasks/${task.id}`, { headers: { 'if-match': '"1"' } })).statusCode, 403);
  });

  await t.test('comments: sanitised, mentions notified, edited by their author, reactions per person', async () => {
    const comments = `${W}/tasks/${task.id}/comments`;
    const posted = await f.call('brand', 'POST', comments, {
      body: { body: '<p>Bay is <b>ready</b><script>alert(1)</script></p>', mentionIds: [f.users.vm.id] },
    });
    assert.equal(posted.statusCode, 201);
    const comment = posted.json<{ id: string; body: string; mentionIds: string[] }>();
    assert.equal(comment.body, '<p>Bay is <b>ready</b></p>');
    assert.deepEqual(comment.mentionIds, [f.users.vm.id]);
    const inbox = (await f.call('vm', 'GET', '/me/notifications?filter=unread')).json<{ items: { type: string; text: string }[] }>();
    assert.equal(inbox.items[0]?.text, 'Test brand mentioned you on GEN-001');

    assert.equal((await f.call('viewer', 'POST', comments, { body: { body: 'Hi' } })).statusCode, 403);
    assert.equal((await f.call('brand', 'POST', comments, { body: { body: '<script>x</script>' } })).json<Problem>().errors?.[0]?.path, 'body');
    const stranger = await f.call('brand', 'POST', comments, { body: { body: 'Hi', mentionIds: [f.users.outsider.id] } });
    assert.equal(stranger.json<Problem>().errors?.[0]?.code, 'unknown_ref');
    const file = await f.call('brand', 'POST', comments, { body: { body: 'See file', fileIds: [f.brandId] } });
    assert.equal(file.json<Problem>().errors?.[0]?.path, 'fileIds');

    const byOther = await f.call('manager', 'PATCH', `${W}/comments/${comment.id}`, { body: { body: 'Edited' }, headers: ifMatch(posted) });
    assert.equal(byOther.statusCode, 403);
    const edited = await f.call('brand', 'PATCH', `${W}/comments/${comment.id}`, { body: { body: 'Bay is ready.' }, headers: ifMatch(posted) });
    assert.equal(edited.json<{ body: string; editedAt: string | null }>().body, 'Bay is ready.');
    assert.ok(edited.json<{ editedAt: string | null }>().editedAt);

    assert.equal((await f.call('vm', 'PUT', `${W}/comments/${comment.id}/reactions/${encodeURIComponent('👍')}`)).statusCode, 204);
    assert.equal((await f.call('brand', 'PUT', `${W}/comments/${comment.id}/reactions/${encodeURIComponent('👍')}`)).statusCode, 204);
    assert.equal((await f.call('brand', 'DELETE', `${W}/comments/${comment.id}/reactions/${encodeURIComponent('👍')}`)).statusCode, 204);
    const list = (await f.call('viewer', 'GET', comments)).json<{ items: { reactions: { emoji: string; userIds: string[] }[] }[] }>();
    assert.deepEqual(list.items[0]?.reactions, [{ emoji: '👍', userIds: [f.users.vm.id] }]);

    assert.equal((await f.call('vm', 'DELETE', `${W}/comments/${comment.id}`, { headers: ifMatch(edited) })).statusCode, 403);
    assert.equal((await f.call('admin', 'DELETE', `${W}/comments/${comment.id}`, { headers: ifMatch(edited) })).statusCode, 204);
    assert.deepEqual((await f.call('viewer', 'GET', comments)).json<{ items: unknown[] }>().items, []);
  });

  await t.test('every task and comment route has a test', () => {
    f.assertCovered(TASK_ROUTES);
  });
});
