import assert from 'node:assert/strict';
import test from 'node:test';
import { applyChanges, buildMutations, createSync, toLegacyData } from '../src/core/sync.js';
import { persistFollowUp } from '../src/launch/followups.js';

class MemoryStorage {
  #values = new Map();
  get length() {
    return this.#values.size;
  }
  key(index) {
    return [...this.#values.keys()][index] ?? null;
  }
  getItem(key) {
    return this.#values.get(key) ?? null;
  }
  setItem(key, value) {
    this.#values.set(key, String(value));
  }
  removeItem(key) {
    this.#values.delete(key);
  }
}

async function waitFor(assertion, timeout = 1000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw last;
}

const PROFILE = {
  user: { id: 'user-1', version: 2, name: 'Synthetic User', email: 'synthetic@example.test' },
  prefs: { theme: 'dark' },
  workspaces: [{ id: 'workspace-1', slug: 'synthetic', name: 'Synthetic' }],
  permissions: { synthetic: { margins: true, contacts: false } },
};

const BOOT = {
  changeSeq: 7,
  workspace: { id: 'workspace-1', slug: 'synthetic', name: 'Synthetic' },
  members: [{ user: PROFILE.user, gr8rRole: 'Owner', teams: ['brand'], version: 3 }],
  teams: [],
  projects: [
    {
      id: 'project-1',
      version: 1,
      key: 'SYN',
      name: 'Synthetic project',
      kind: 'general',
      colour: '#5A67D8',
      memberIds: ['user-1'],
      favourite: true,
    },
  ],
  tasks: [
    {
      id: 'task-1',
      version: 1,
      projectId: 'project-1',
      title: 'Synthetic task',
      status: 'todo',
      priority: 'medium',
      subtasks: [],
      dependencyIds: [],
      attachmentIds: [],
    },
  ],
  comments: [
    {
      id: 'comment-1',
      version: 1,
      taskId: 'task-1',
      authorId: 'user-1',
      body: 'Synthetic comment',
      reactions: [{ emoji: 'ok', userIds: ['user-1'] }],
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  notifications: [],
  activity: [],
  files: [],
  events: [],
  savedViews: [],
  favourites: [{ kind: 'project', id: 'project-1' }],
};

test('canonical bootstrap maps once to the legacy gr8r shape', () => {
  const mapped = toLegacyData(BOOT, PROFILE, { permissions: { margins: true, contacts: false }, brandMarketMargins: [] });
  assert.equal(mapped.me, 'user-1');
  assert.equal(mapped.members[0].role, 'Owner');
  assert.equal(mapped.projects[0].color, 'indigo');
  assert.equal(mapped.tasks[0].project, 'project-1');
  assert.equal(mapped.comments[0].text, 'Synthetic comment');
  assert.deepEqual(mapped.comments[0].re, { ok: ['user-1'] });
  assert.equal(mapped.authorized.launchDirectory.permissions.contacts, false);
});

test('ordered changes replace, append and tombstone canonical rows', () => {
  const base = structuredClone(BOOT);
  base.tasks[0].subtasks = [{ id: 'subtask-1', taskId: 'task-1', title: 'Old', done: false }];
  base.tasks[0].lineStores = [{ id: 'line-store-1', taskId: 'task-1', storeId: 'store-1', values: {} }];
  const next = applyChanges(base, [
    { kind: 'task', id: 'task-1', data: { ...BOOT.tasks[0], title: 'Changed' } },
    { kind: 'event', id: 'event-1', data: { id: 'event-1', title: 'Visit' } },
    { kind: 'comment', id: 'comment-1', deleted: true, data: null },
    { kind: 'subtask', id: 'subtask-1', data: { id: 'subtask-1', taskId: 'task-1', title: 'Changed subtask', done: true } },
    { kind: 'lineStore', id: 'line-store-1', deleted: true, data: null },
    { kind: 'lineStore', id: 'line-store-2', data: { id: 'line-store-2', taskId: 'task-1', storeId: 'store-2', values: { ready: true } } },
  ]);
  assert.equal(next.tasks[0].title, 'Changed');
  assert.deepEqual(
    next.tasks[0].subtasks.map(row => [row.id, row.title, row.done]),
    [['subtask-1', 'Changed subtask', true]],
  );
  assert.deepEqual(
    next.tasks[0].lineStores.map(row => row.id),
    ['line-store-2'],
  );
  assert.equal(next.events[0].id, 'event-1');
  assert.deepEqual(next.comments, []);
  assert.equal(BOOT.tasks[0].title, 'Synthetic task', 'the cached base is immutable');
});

test('same-user cached rows are never published before a current visibility bootstrap', async () => {
  const storage = new MemoryStorage();
  const stale = structuredClone(BOOT);
  stale.projects.push({ id: 'private-project', version: 1, name: 'Revoked private project', private: true, memberIds: ['user-1'] });
  stale.tasks.push({ id: 'private-task', version: 1, projectId: 'private-project', title: 'Private task', subtasks: [] });
  storage.setItem('lt.cache.active', JSON.stringify({ userId: 'user-1', workspaceId: 'workspace-1' }));
  storage.setItem('lt.cache.v1:user-1:workspace-1', JSON.stringify({ userId: 'user-1', workspaceId: 'workspace-1', changeSeq: 6, base: stale, outbox: [] }));
  const seen = [];
  const request = async path => {
    if (path === '/api/v1/me') return { data: PROFILE };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(BOOT) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    throw new Error(`unexpected ${path}`);
  };
  const sync = createSync({
    request,
    workspacePath: (workspace, path) => `/api/v1/w/${workspace}${path}`,
    storage,
    onData: data => seen.push(data),
    setTimer: () => 1,
    clearTimer: () => {},
    events: {},
  });

  await sync.start();

  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].projects.some(project => project.id === 'private-project'),
    false,
  );
  assert.equal(
    seen[0].tasks.some(task => task.id === 'private-task'),
    false,
  );
});

test('a refresh drops revoked private rows even when the filtered change feed has no tombstone', async () => {
  const storage = new MemoryStorage();
  const initiallyVisible = structuredClone(BOOT);
  initiallyVisible.projects.push({ id: 'private-project', version: 1, name: 'Private project', private: true, memberIds: ['user-1'] });
  initiallyVisible.tasks.push({ id: 'private-task', version: 1, projectId: 'private-project', title: 'Private task', subtasks: [] });
  let serverBoot = initiallyVisible;
  const seen = [];
  const request = async path => {
    if (path === '/api/v1/me') return { data: PROFILE };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path.startsWith('/api/v1/w/synthetic/changes?')) return { data: { items: [], nextSince: 8, hasMore: false } };
    throw new Error(`unexpected ${path}`);
  };
  const sync = createSync({
    request,
    workspacePath: (workspace, path) => `/api/v1/w/${workspace}${path}`,
    storage,
    onData: data => seen.push(data),
    setTimer: () => 1,
    clearTimer: () => {},
    events: {},
  });
  await sync.start();
  assert.ok(seen.at(-1).projects.some(project => project.id === 'private-project'));

  serverBoot = structuredClone(BOOT);
  await sync.pull();
  sync.stop();

  assert.equal(
    seen.at(-1).projects.some(project => project.id === 'private-project'),
    false,
  );
  assert.equal(
    seen.at(-1).tasks.some(task => task.id === 'private-task'),
    false,
  );
});

test('a sessions 401 aborts boot without rendering or retaining a workspace cache', async () => {
  const storage = new MemoryStorage();
  storage.setItem('lt.cache.active', JSON.stringify({ userId: 'user-1', workspaceId: 'workspace-1' }));
  storage.setItem('lt.cache.v1:user-1:workspace-1', JSON.stringify({ userId: 'user-1', workspaceId: 'workspace-1', base: BOOT, outbox: [] }));
  let renders = 0;
  const unauthorized = Object.assign(new Error('Sign in again.'), { status: 401 });
  const request = async path => {
    if (path === '/api/v1/me') return { data: PROFILE };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: BOOT };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: {} } };
    if (path === '/api/v1/me/sessions') throw unauthorized;
    throw new Error(`unexpected ${path}`);
  };
  const sync = createSync({
    request,
    workspacePath: (workspace, path) => `/api/v1/w/${workspace}${path}`,
    storage,
    onData: () => {
      renders += 1;
    },
    setTimer: () => 1,
    clearTimer: () => {},
    events: {},
  });

  await assert.rejects(sync.start(), error => error === unauthorized);
  assert.equal(renders, 0);
  assert.equal(storage.getItem('lt.cache.active'), null);
  assert.equal(storage.getItem('lt.cache.v1:user-1:workspace-1'), null);
});

test('diffs order dependent project, task and comment creates', () => {
  const after = {
    projects: [{ id: 'local-project', name: 'New' }],
    tasks: [{ id: 'local-task', project: 'local-project' }],
    comments: [{ id: 'local-comment' }],
  };
  assert.deepEqual(
    buildMutations({ projects: [], tasks: [], comments: [] }, after).map(item => item.resource),
    ['project', 'task', 'comment'],
  );
});

test('boot validates identity before cache use and never caches restricted directory rows', async () => {
  const storage = new MemoryStorage();
  storage.setItem('lt.cache.active', JSON.stringify({ userId: 'different-user', workspaceId: 'old' }));
  storage.setItem('lt.cache.v1:different-user:old', JSON.stringify({ base: { contacts: [{ email: 'private@example.test' }] } }));
  const seen = [];
  const request = async path => {
    if (path === '/api/v1/me') return { data: PROFILE };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: BOOT };
    if (path === '/api/v1/w/synthetic/directory')
      return { data: { permissions: { margins: true, contacts: false }, brandMarketMargins: [{ brandMarketId: 'bm-1', margin: 0.25 }] } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    throw new Error(`unexpected ${path}`);
  };
  const sync = createSync({
    request,
    workspacePath: (workspace, path) => `/api/v1/w/${workspace}${path}`,
    storage,
    onData: data => seen.push(data),
    setTimer: () => 1,
    clearTimer: () => {},
    events: {},
  });
  await sync.start();
  assert.equal(seen.at(-1).authorized.launchDirectory.brandMarketMargins[0].margin, 0.25);
  assert.equal(storage.getItem('lt.cache.v1:different-user:old'), null);
  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  const cache = storage.getItem(pointer.key);
  assert.ok(cache.includes('Synthetic project'));
  assert.ok(!cache.includes('brandMarketMargins'));
  assert.ok(!cache.includes('private@example.test'));
});

test('offline snapshots use the canonical subtask, dependency and reaction routes', async () => {
  const storage = new MemoryStorage();
  const calls = [];
  let visible;
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/me') return { data: PROFILE };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: BOOT };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path.endsWith('/subtasks') && options.method === 'POST') return { data: { id: 'subtask-1' } };
    if (options.method === 'PUT') return { data: null };
    throw new Error(`unexpected ${options.method || 'GET'} ${path}`);
  };
  const sync = createSync({
    request,
    workspacePath: (workspace, path) => `/api/v1/w/${workspace}${path}`,
    storage,
    onData: data => {
      visible = data;
    },
    setTimer: () => 1,
    clearTimer: () => {},
    events: {},
  });
  await sync.start();
  const next = structuredClone(visible);
  next.tasks[0].subtasks.push({ id: 'local-subtask', title: 'Synthetic subtask', done: false, position: 0 });
  next.tasks[0].deps.push('task-2');
  next.comments[0].re['new reaction'] = ['user-1'];

  sync.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  await sync.flush();

  assert.ok(calls.some(call => call.path === '/api/v1/w/synthetic/tasks/task-1/subtasks' && call.options.method === 'POST'));
  assert.ok(calls.some(call => call.path === '/api/v1/w/synthetic/tasks/task-1/dependencies/task-2' && call.options.method === 'PUT'));
  assert.ok(calls.some(call => call.path === '/api/v1/w/synthetic/comments/comment-1/reactions/new%20reaction' && call.options.method === 'PUT'));
});

test('partial outbox success is checkpointed and does not replay an accepted edit after restart', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  let projectPatches = 0;
  let taskPatches = 0;
  let failTask = true;
  let visible;
  const statuses = [];
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/projects/project-1' && options.method === 'PATCH') {
      projectPatches += 1;
      serverBoot.projects[0] = { ...serverBoot.projects[0], ...options.body, version: 2 };
      return { data: structuredClone(serverBoot.projects[0]) };
    }
    if (path === '/api/v1/w/synthetic/tasks/task-1' && options.method === 'PATCH') {
      taskPatches += 1;
      if (failTask) throw new Error('The connection dropped after the project edit.');
      serverBoot.tasks[0] = { ...serverBoot.tasks[0], ...options.body, version: 2 };
      return { data: structuredClone(serverBoot.tasks[0]) };
    }
    throw new Error(`unexpected ${options.method || 'GET'} ${path}`);
  };
  const options = {
    request,
    workspacePath: (workspace, path) => `/api/v1/w/${workspace}${path}`,
    storage,
    onData: data => {
      visible = data;
    },
    onStatus: status => statuses.push(status),
    setTimer: () => 1,
    clearTimer: () => {},
    events: {},
  };
  const first = createSync(options);
  await first.start();
  const next = structuredClone(visible);
  next.projects[0].name = 'Accepted project name';
  next.tasks[0].title = 'Pending task title';
  first.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));

  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  const interrupted = JSON.parse(storage.getItem(pointer.key));
  assert.ok(interrupted.outbox[0].completed.includes('project:update:project-1'));
  first.stop();

  failTask = false;
  const second = createSync(options);
  await second.start();
  second.stop();

  assert.equal(projectPatches, 1, 'the accepted project edit is not replayed with its stale ETag');
  assert.equal(taskPatches, 2, 'only the interrupted task edit is retried');
  assert.equal(serverBoot.tasks[0].title, 'Pending task title');
  assert.deepEqual(JSON.parse(storage.getItem(pointer.key)).outbox, []);
});

test('a local follow-up uses the atomic server route and suppresses synthetic child writes', async () => {
  const storage = new MemoryStorage();
  const calls = [];
  let visible;
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/api/v1/me') return { data: PROFILE };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(BOOT) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/tasks/task-1/follow-ups' && options.method === 'POST') return { data: { id: 'server-follow-up', version: 1 } };
    throw new Error(`unexpected ${options.method || 'GET'} ${path}`);
  };
  const sync = createSync({
    request,
    workspacePath: (workspace, path) => `/api/v1/w/${workspace}${path}`,
    storage,
    onData: data => {
      visible = data;
    },
    setTimer: () => 1,
    clearTimer: () => {},
    events: {},
  });
  await sync.start();
  const next = structuredClone(visible);
  persistFollowUp({
    data: next,
    line: next.tasks[0],
    gate: { key: 'vm_dressed', name: 'VM dressed' },
    owner: 'user-1',
    ownerName: 'Synthetic User',
    due: '2026-11-05',
    note: 'Check the display',
    by: 'user-1',
    now: Date.parse('2026-11-02T12:00:00Z'),
    today: '2026-11-02',
    ids: { task: 'local-follow-up', comment: 'local-comment', notification: 'local-notification' },
    key: 'SYN-2',
  });
  sync.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  await waitFor(() => assert.ok(calls.some(call => call.path.endsWith('/tasks/task-1/follow-ups') && call.options.method === 'POST')));
  await waitFor(() => assert.equal(JSON.parse(storage.getItem(JSON.parse(storage.getItem('lt.cache.active')).key)).outbox.length, 0));
  sync.stop();

  const writes = calls.filter(call => call.options.method);
  assert.equal(writes.filter(call => call.path.endsWith('/tasks/task-1/follow-ups')).length, 1);
  assert.equal(
    writes.some(call => call.path === '/api/v1/w/synthetic/tasks' && call.options.method === 'POST'),
    false,
  );
  assert.equal(
    writes.some(call => call.path.endsWith('/comments') && call.options.method === 'POST'),
    false,
  );
  assert.deepEqual(writes.find(call => call.path.endsWith('/tasks/task-1/follow-ups')).options.body, {
    title: 'Follow up: VM dressed · Synthetic task',
    gate: 'vm_dressed',
    storeId: null,
    assigneeId: 'user-1',
    dueDate: '2026-11-05',
    note: 'Check the display',
  });
});
