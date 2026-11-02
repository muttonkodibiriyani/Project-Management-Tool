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

test('accepted project, task and comment edits survive lost responses and resume later work', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  let serverProfile = structuredClone(PROFILE);
  let visible;
  const statuses = [];
  const attempts = { project: 0, task: 0, comment: 0, prefs: 0 };
  const semanticWrites = { project: 0, task: 0, comment: 0 };
  const etags = { project: [], task: [], comment: [] };
  const loseResponse = { project: true, task: true, comment: true };
  const applyThenLose = (resource, rows, id, body) => {
    attempts[resource] += 1;
    etags[resource].push(body.etag);
    const current = rows.find(row => row.id === id);
    if (body.etag !== current.version) throw Object.assign(new Error(`${resource} version conflict.`), { status: 409 });
    semanticWrites[resource] += 1;
    Object.assign(current, body.patch, { version: current.version + 1 });
    if (loseResponse[resource]) {
      loseResponse[resource] = false;
      throw new Error(`The ${resource} response was lost after server acceptance.`);
    }
    return { data: structuredClone(current) };
  };
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me' && !options.method) return { data: structuredClone(serverProfile) };
    if (path === '/api/v1/me' && options.method === 'PATCH') {
      attempts.prefs += 1;
      serverProfile = { ...serverProfile, prefs: options.body.prefs, user: { ...serverProfile.user, version: serverProfile.user.version + 1 } };
      return { data: structuredClone(serverProfile) };
    }
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/projects/project-1' && options.method === 'PATCH')
      return applyThenLose('project', serverBoot.projects, 'project-1', { etag: options.etag, patch: options.body });
    if (path === '/api/v1/w/synthetic/tasks/task-1' && options.method === 'PATCH')
      return applyThenLose('task', serverBoot.tasks, 'task-1', { etag: options.etag, patch: options.body });
    if (path === '/api/v1/w/synthetic/comments/comment-1' && options.method === 'PATCH')
      return applyThenLose('comment', serverBoot.comments, 'comment-1', { etag: options.etag, patch: { body: options.body.body } });
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
  next.projects[0].name = 'Accepted project edit';
  next.tasks[0].title = 'Accepted task edit';
  next.comments[0].text = 'Accepted comment edit';
  first.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  const final = structuredClone(next);
  final.projects[0].name = 'Final project edit';
  final.tasks[0].title = 'Final task edit';
  final.comments[0].text = 'Final comment edit';
  first.queueSnapshot({ data: final, prefs: { theme: 'light' } });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));
  first.stop();

  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  for (let restart = 0; restart < 3; restart += 1) {
    const resumed = createSync(options);
    await resumed.start();
    resumed.stop();
  }

  assert.deepEqual(attempts, { project: 2, task: 2, comment: 2, prefs: 1 });
  assert.deepEqual(semanticWrites, { project: 2, task: 2, comment: 2 });
  assert.deepEqual(etags, { project: [1, 2], task: [1, 2], comment: [1, 2] });
  assert.equal(serverBoot.projects[0].name, 'Final project edit');
  assert.equal(serverBoot.tasks[0].title, 'Final task edit');
  assert.equal(serverBoot.comments[0].body, 'Final comment edit');
  assert.deepEqual(serverProfile.prefs, { theme: 'light' }, 'later edits use the reconciled versions and still complete');
  const completed = JSON.parse(storage.getItem(pointer.key));
  assert.deepEqual(completed.outbox, []);
  assert.deepEqual(completed.rowCheckpoints, {});
});

test('an accepted delete with a lost response is completed from canonical absence after restart', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  let visible;
  let deleteAttempts = 0;
  let semanticDeletes = 0;
  const statuses = [];
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/comments/comment-1' && options.method === 'DELETE') {
      deleteAttempts += 1;
      const current = serverBoot.comments.find(comment => comment.id === 'comment-1');
      if (options.etag !== current?.version) throw Object.assign(new Error('Comment version conflict.'), { status: 409 });
      semanticDeletes += 1;
      serverBoot.comments = serverBoot.comments.filter(comment => comment.id !== 'comment-1');
      throw new Error('The delete response was lost after server acceptance.');
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
  next.comments = [];
  first.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));
  first.stop();

  const resumed = createSync(options);
  await resumed.start();
  resumed.stop();

  assert.equal(deleteAttempts, 1);
  assert.equal(semanticDeletes, 1);
  assert.equal(serverBoot.comments.length, 0);
  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  assert.deepEqual(JSON.parse(storage.getItem(pointer.key)).outbox, []);
});

test('a concurrent change after an ambiguous edit remains a version conflict', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  let visible;
  let patchAttempts = 0;
  let dropBeforeApply = true;
  const statuses = [];
  const conflicts = [];
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/projects/project-1' && options.method === 'PATCH') {
      patchAttempts += 1;
      if (dropBeforeApply) {
        dropBeforeApply = false;
        throw new Error('The request was lost before the server applied it.');
      }
      throw new Error('The stale patch must not be retried.');
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
    onConflict: error => conflicts.push(error),
    setTimer: () => 1,
    clearTimer: () => {},
    events: {},
  };
  const first = createSync(options);
  await first.start();
  const next = structuredClone(visible);
  next.projects[0].name = 'My pending edit';
  first.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));
  first.stop();

  serverBoot.projects[0] = { ...serverBoot.projects[0], name: 'Changed by another user', version: 2 };
  const resumed = createSync(options);
  await resumed.start();
  resumed.stop();

  assert.equal(patchAttempts, 1, 'a freshly detected version conflict never retries the stale write');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].status, 409);
  assert.equal(serverBoot.projects[0].name, 'Changed by another user');
  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  assert.equal(JSON.parse(storage.getItem(pointer.key)).outbox.length, 1, 'the conflict remains available for user resolution');
});

test('an accepted notification edit with a lost response reconciles after restart', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  serverBoot.notifications = [
    {
      id: 'notification-1',
      version: 1,
      userId: 'user-1',
      actorId: 'user-1',
      taskId: 'task-1',
      type: 'assignment',
      text: 'Synthetic notification',
      readAt: null,
      archived: false,
      createdAt: '2026-11-02T12:00:00.000Z',
    },
  ];
  let visible;
  let patchAttempts = 0;
  const statuses = [];
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/me/notifications/notification-1' && options.method === 'PATCH') {
      patchAttempts += 1;
      const current = serverBoot.notifications[0];
      if (options.etag !== current.version) throw Object.assign(new Error('Notification version conflict.'), { status: 409 });
      Object.assign(current, {
        readAt: options.body.read ? '2026-11-02T12:30:00.000Z' : null,
        archived: options.body.archived,
        version: current.version + 1,
      });
      throw new Error('The notification response was lost after server acceptance.');
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
  next.notifs[0].read = true;
  first.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));
  first.stop();

  const resumed = createSync(options);
  await resumed.start();
  resumed.stop();

  assert.equal(patchAttempts, 1);
  assert.equal(serverBoot.notifications[0].version, 2);
  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  assert.deepEqual(JSON.parse(storage.getItem(pointer.key)).outbox, []);
});

test('a resumed edit never invents a delete for a concurrent remote create', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  let taskPatches = 0;
  let projectDeletes = 0;
  let failTask = true;
  let visible;
  const statuses = [];
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/tasks/task-1' && options.method === 'PATCH') {
      taskPatches += 1;
      if (failTask) throw new Error('The local task edit lost its connection.');
      serverBoot.tasks[0] = { ...serverBoot.tasks[0], ...options.body, version: 2 };
      return { data: structuredClone(serverBoot.tasks[0]) };
    }
    if (path === '/api/v1/w/synthetic/projects/concurrent-project' && options.method === 'DELETE') {
      projectDeletes += 1;
      serverBoot.projects = serverBoot.projects.filter(project => project.id !== 'concurrent-project');
      return { data: null };
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
  next.tasks[0].title = 'Queued local edit';
  first.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));
  first.stop();

  serverBoot.projects.push({
    id: 'concurrent-project',
    version: 1,
    key: 'OTHER',
    name: 'Created by another user',
    kind: 'general',
    colour: '#5A67D8',
    memberIds: ['user-1'],
  });
  failTask = false;
  const second = createSync(options);
  await second.start();
  second.stop();

  assert.equal(taskPatches, 2);
  assert.equal(projectDeletes, 0, 'the immutable queued plan contains no delete for the unseen concurrent row');
  assert.ok(serverBoot.projects.some(project => project.id === 'concurrent-project'));
  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  assert.deepEqual(JSON.parse(storage.getItem(pointer.key)).outbox, []);
});

test('a resumed edit never resurrects a concurrently deleted remote row', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  serverBoot.projects.push({
    id: 'removed-project',
    version: 1,
    key: 'OLD',
    name: 'Removed by another user',
    kind: 'general',
    colour: '#5A67D8',
    memberIds: ['user-1'],
  });
  let taskPatches = 0;
  let projectCreates = 0;
  let failTask = true;
  let visible;
  const statuses = [];
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/tasks/task-1' && options.method === 'PATCH') {
      taskPatches += 1;
      if (failTask) throw new Error('The local task edit lost its connection.');
      serverBoot.tasks[0] = { ...serverBoot.tasks[0], ...options.body, version: 2 };
      return { data: structuredClone(serverBoot.tasks[0]) };
    }
    if (path === '/api/v1/w/synthetic/projects' && options.method === 'POST') {
      projectCreates += 1;
      return { data: { id: 'resurrected-project', version: 1, ...options.body } };
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
  next.tasks[0].title = 'Queued local edit';
  first.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));
  first.stop();

  serverBoot.projects = serverBoot.projects.filter(project => project.id !== 'removed-project');
  failTask = false;
  const second = createSync(options);
  await second.start();
  second.stop();

  assert.equal(taskPatches, 2);
  assert.equal(projectCreates, 0, 'the immutable queued plan contains no create for the concurrently removed row');
  assert.equal(
    serverBoot.projects.some(project => project.id === 'removed-project'),
    false,
  );
  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  assert.deepEqual(JSON.parse(storage.getItem(pointer.key)).outbox, []);
});

test('a queued edit to a just-created row uses the accepted create version', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  let projectPosts = 0;
  let projectPatches = 0;
  let projectDeletes = 0;
  const patchEtags = [];
  let visible;
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/projects' && options.method === 'POST') {
      projectPosts += 1;
      const created = { id: 'server-project', version: 1, ...options.body, memberIds: [], favourite: false };
      serverBoot.projects.push(created);
      return { data: structuredClone(created) };
    }
    if (path === '/api/v1/w/synthetic/projects/server-project' && options.method === 'PATCH') {
      projectPatches += 1;
      patchEtags.push(options.etag);
      const current = serverBoot.projects.find(project => project.id === 'server-project');
      if (options.etag !== current.version) throw Object.assign(new Error('A row version is required.'), { status: 428 });
      Object.assign(current, options.body, { version: current.version + 1 });
      return { data: structuredClone(current) };
    }
    if (path === '/api/v1/w/synthetic/projects/server-project' && options.method === 'DELETE') {
      projectDeletes += 1;
      return { data: null };
    }
    throw new Error(`unexpected ${options.method || 'GET'} ${path}`);
  };
  const controller = createSync({
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
  await controller.start();
  const created = structuredClone(visible);
  created.projects.push({
    id: 'local-project',
    key: 'NEW',
    name: 'First name',
    kind: 'general',
    color: 'indigo',
    status: 'planning',
    members: [],
  });
  controller.queueSnapshot({ data: created, prefs: PROFILE.prefs });
  const edited = structuredClone(created);
  edited.projects.at(-1).name = 'Final name';
  controller.queueSnapshot({ data: edited, prefs: PROFILE.prefs });
  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  await waitFor(() => assert.deepEqual(JSON.parse(storage.getItem(pointer.key)).outbox, []));
  controller.stop();

  assert.equal(projectPosts, 1);
  assert.equal(projectPatches, 1);
  assert.deepEqual(patchEtags, [1]);
  assert.equal(projectDeletes, 0);
  assert.equal(serverBoot.projects.find(project => project.id === 'server-project').name, 'Final name');
  assert.deepEqual(JSON.parse(storage.getItem(pointer.key)).rowCheckpoints, {});
});

test('a queued edit to a just-created row keeps its accepted version across restart', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  let projectPosts = 0;
  let projectPatches = 0;
  let projectDeletes = 0;
  let failPatch = true;
  const patchEtags = [];
  const statuses = [];
  let visible;
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/projects' && options.method === 'POST') {
      projectPosts += 1;
      const created = { id: 'server-project', version: 1, ...options.body, memberIds: [], favourite: false };
      serverBoot.projects.push(created);
      return { data: structuredClone(created) };
    }
    if (path === '/api/v1/w/synthetic/projects/server-project' && options.method === 'PATCH') {
      projectPatches += 1;
      patchEtags.push(options.etag);
      if (failPatch) throw new Error('The edit response was interrupted.');
      const current = serverBoot.projects.find(project => project.id === 'server-project');
      if (options.etag !== current.version) throw Object.assign(new Error('A row version is required.'), { status: 428 });
      Object.assign(current, options.body, { version: current.version + 1 });
      return { data: structuredClone(current) };
    }
    if (path === '/api/v1/w/synthetic/projects/server-project' && options.method === 'DELETE') {
      projectDeletes += 1;
      return { data: null };
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
  const created = structuredClone(visible);
  created.projects.push({
    id: 'local-project',
    key: 'NEW',
    name: 'First name',
    kind: 'general',
    color: 'indigo',
    status: 'planning',
    members: [],
  });
  first.queueSnapshot({ data: created, prefs: PROFILE.prefs });
  const edited = structuredClone(created);
  edited.projects.at(-1).name = 'Final name';
  first.queueSnapshot({ data: edited, prefs: PROFILE.prefs });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));
  first.stop();

  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  const interrupted = JSON.parse(storage.getItem(pointer.key));
  assert.deepEqual(interrupted.rowCheckpoints['project:local-project'], {
    id: 'server-project',
    version: 1,
    row: serverBoot.projects.find(project => project.id === 'server-project'),
  });
  assert.equal(interrupted.idMap['local-project'], 'server-project');

  failPatch = false;
  const second = createSync(options);
  await second.start();
  second.stop();

  assert.equal(projectPosts, 1, 'restart never repeats the accepted create');
  assert.equal(projectPatches, 2);
  assert.deepEqual(patchEtags, [1, 1]);
  assert.equal(projectDeletes, 0);
  assert.equal(serverBoot.projects.find(project => project.id === 'server-project').name, 'Final name');
  const completed = JSON.parse(storage.getItem(pointer.key));
  assert.deepEqual(completed.outbox, []);
  assert.deepEqual(completed.rowCheckpoints, {});
});

for (const scenario of [
  { name: 'in one session', loseFirstCreateResponse: false },
  { name: 'after a lost create response and restart', loseFirstCreateResponse: true },
]) {
  test(`chained project, task and comment creates keep canonical ids and versions ${scenario.name}`, async () => {
    const storage = new MemoryStorage();
    let serverBoot = structuredClone(BOOT);
    let loseProjectResponse = scenario.loseFirstCreateResponse;
    let projectTransports = 0;
    let projectCreates = 0;
    let taskCreates = 0;
    let commentCreates = 0;
    let deletes = 0;
    const projectPatchEtags = [];
    const taskPatchEtags = [];
    const commentPatchEtags = [];
    const taskProjectIds = [];
    const commentPaths = [];
    const statuses = [];
    let visible;
    const request = async (path, options = {}) => {
      if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
      if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
      if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
      if (path === '/api/v1/me/sessions') return { data: { items: [] } };
      if (options.method === 'DELETE') {
        deletes += 1;
        return { data: null };
      }
      if (path === '/api/v1/w/synthetic/projects' && options.method === 'POST') {
        projectTransports += 1;
        let created = serverBoot.projects.find(project => project.id === 'server-project');
        if (!created) {
          projectCreates += 1;
          created = { id: 'server-project', version: 11, ...options.body, memberIds: [], favourite: false };
          serverBoot.projects.push(created);
        }
        if (loseProjectResponse) {
          loseProjectResponse = false;
          throw new Error('The create response was lost after server acceptance.');
        }
        return { data: structuredClone(created) };
      }
      if (path === '/api/v1/w/synthetic/tasks' && options.method === 'POST') {
        taskCreates += 1;
        taskProjectIds.push(options.body.projectId);
        const created = {
          id: 'server-task',
          version: 21,
          ...options.body,
          subtasks: [],
          dependencyIds: [],
          attachmentIds: [],
        };
        serverBoot.tasks.push(created);
        return { data: structuredClone(created) };
      }
      if (path === '/api/v1/w/synthetic/tasks/server-task/comments' && options.method === 'POST') {
        commentCreates += 1;
        commentPaths.push(path);
        const created = {
          id: 'server-comment',
          version: 31,
          taskId: 'server-task',
          authorId: 'user-1',
          body: options.body.body,
          reactions: [],
          createdAt: '2026-11-02T12:00:00.000Z',
        };
        serverBoot.comments.push(created);
        return { data: structuredClone(created) };
      }
      if (path === '/api/v1/w/synthetic/projects/server-project' && options.method === 'PATCH') {
        projectPatchEtags.push(options.etag);
        const current = serverBoot.projects.find(project => project.id === 'server-project');
        if (options.etag !== current.version) throw Object.assign(new Error('Project version mismatch.'), { status: 409 });
        Object.assign(current, options.body, { version: current.version + 1 });
        return { data: structuredClone(current) };
      }
      if (path === '/api/v1/w/synthetic/tasks/server-task' && options.method === 'PATCH') {
        taskPatchEtags.push(options.etag);
        const current = serverBoot.tasks.find(task => task.id === 'server-task');
        if (options.etag !== current.version) throw Object.assign(new Error('Task version mismatch.'), { status: 409 });
        Object.assign(current, options.body, { version: current.version + 1 });
        return { data: structuredClone(current) };
      }
      if (path === '/api/v1/w/synthetic/comments/server-comment' && options.method === 'PATCH') {
        commentPatchEtags.push(options.etag);
        const current = serverBoot.comments.find(comment => comment.id === 'server-comment');
        if (options.etag !== current.version) throw Object.assign(new Error('Comment version mismatch.'), { status: 409 });
        Object.assign(current, { body: options.body.body, version: current.version + 1 });
        return { data: structuredClone(current) };
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
    const created = structuredClone(visible);
    created.projects.push({
      id: 'local-project',
      key: 'NEW',
      name: 'First project name',
      kind: 'general',
      color: 'indigo',
      status: 'planning',
      members: [],
    });
    created.tasks.push({
      id: 'local-task',
      project: 'local-project',
      title: 'First task title',
      status: 'todo',
      priority: 'medium',
      subtasks: [],
      deps: [],
    });
    first.queueSnapshot({ data: created, prefs: PROFILE.prefs });

    const edited = structuredClone(created);
    edited.projects.at(-1).name = 'Final project name';
    edited.tasks.at(-1).title = 'Final task title';
    edited.comments.push({ id: 'local-comment', task: 'local-task', author: 'user-1', text: 'First comment', re: {} });
    first.queueSnapshot({ data: edited, prefs: PROFILE.prefs });

    const childEdited = structuredClone(edited);
    childEdited.comments.at(-1).text = 'Final comment';
    first.queueSnapshot({ data: childEdited, prefs: PROFILE.prefs });

    if (scenario.loseFirstCreateResponse) {
      await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));
      first.stop();
      const resumed = createSync(options);
      await resumed.start();
      resumed.stop();
    } else {
      const pointer = JSON.parse(storage.getItem('lt.cache.active'));
      await waitFor(() => assert.deepEqual(JSON.parse(storage.getItem(pointer.key)).outbox, []));
      first.stop();
    }

    assert.equal(projectTransports, scenario.loseFirstCreateResponse ? 2 : 1);
    assert.equal(projectCreates, 1, 'the idempotency key accepts the project create once');
    assert.equal(taskCreates, 1);
    assert.equal(commentCreates, 1);
    assert.equal(deletes, 0);
    assert.deepEqual(taskProjectIds, ['server-project']);
    assert.deepEqual(commentPaths, ['/api/v1/w/synthetic/tasks/server-task/comments']);
    assert.deepEqual(projectPatchEtags, [11]);
    assert.deepEqual(taskPatchEtags, [21]);
    assert.deepEqual(commentPatchEtags, [31]);
    assert.equal(serverBoot.projects.find(project => project.id === 'server-project').name, 'Final project name');
    assert.equal(serverBoot.tasks.find(task => task.id === 'server-task').title, 'Final task title');
    assert.equal(serverBoot.comments.find(comment => comment.id === 'server-comment').body, 'Final comment');
    const pointer = JSON.parse(storage.getItem('lt.cache.active'));
    const completed = JSON.parse(storage.getItem(pointer.key));
    assert.deepEqual(completed.outbox, []);
    assert.deepEqual(completed.rowCheckpoints, {});
  });
}

test('an accepted create keeps its server identity when a later edit resumes after restart', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  let projectCreates = 0;
  let projectDeletes = 0;
  let taskPatches = 0;
  let failTask = true;
  let visible;
  const statuses = [];
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/projects' && options.method === 'POST') {
      projectCreates += 1;
      const created = { id: 'server-project', version: 1, ...options.body, memberIds: [], favourite: false };
      serverBoot.projects.push(created);
      return { data: structuredClone(created) };
    }
    if (path === '/api/v1/w/synthetic/projects/server-project' && options.method === 'DELETE') {
      projectDeletes += 1;
      serverBoot.projects = serverBoot.projects.filter(project => project.id !== 'server-project');
      return { data: null };
    }
    if (path === '/api/v1/w/synthetic/tasks/task-1' && options.method === 'PATCH') {
      taskPatches += 1;
      if (failTask) throw new Error('The connection dropped after the project create.');
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
  next.projects.push({
    id: 'local-project',
    key: 'NEW',
    name: 'Created before interruption',
    kind: 'general',
    color: 'indigo',
    status: 'planning',
    members: [],
  });
  next.tasks[0].title = 'Pending after create';
  first.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));

  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  const interrupted = JSON.parse(storage.getItem(pointer.key));
  assert.equal(interrupted.idMap['local-project'], 'server-project');
  assert.ok(interrupted.outbox[0].completed.includes('project:create:local-project'));
  first.stop();

  failTask = false;
  const second = createSync(options);
  await second.start();
  second.stop();

  assert.equal(projectCreates, 1, 'the accepted create is not repeated');
  assert.equal(projectDeletes, 0, 'the accepted remote row is not mistaken for a deletion');
  assert.equal(taskPatches, 2, 'only the interrupted edit is retried');
  assert.ok(serverBoot.projects.some(project => project.id === 'server-project'));
  assert.deepEqual(JSON.parse(storage.getItem(pointer.key)).outbox, []);
});

test('an ambiguous create retry never executes the stale remote-twin delete', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  let projectPosts = 0;
  let serverCreates = 0;
  let projectDeletes = 0;
  let dropCreateResponse = true;
  let visible;
  const statuses = [];
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me') return { data: structuredClone(PROFILE) };
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/projects' && options.method === 'POST') {
      projectPosts += 1;
      let created = serverBoot.projects.find(project => project.id === 'server-project');
      if (!created) {
        serverCreates += 1;
        created = { id: 'server-project', version: 1, ...options.body, memberIds: [], favourite: false };
        serverBoot.projects.push(created);
      }
      if (dropCreateResponse) throw new Error('The response was lost after the server accepted the create.');
      return { data: structuredClone(created) };
    }
    if (path === '/api/v1/w/synthetic/projects/server-project' && options.method === 'DELETE') {
      projectDeletes += 1;
      serverBoot.projects = serverBoot.projects.filter(project => project.id !== 'server-project');
      return { data: null };
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
  next.projects.push({ id: 'local-project', key: 'NEW', name: 'Ambiguous create', kind: 'general', color: 'indigo', status: 'planning', members: [] });
  first.queueSnapshot({ data: next, prefs: PROFILE.prefs });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));
  first.stop();

  dropCreateResponse = false;
  const second = createSync(options);
  await second.start();
  second.stop();

  assert.equal(projectPosts, 2, 'the stable idempotency key retries the ambiguous request once');
  assert.equal(serverCreates, 1, 'the server accepts only one create');
  assert.equal(projectDeletes, 0, 'the preplanned delete of the remote twin is suppressed');
  assert.ok(serverBoot.projects.some(project => project.id === 'server-project'));
  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
  assert.deepEqual(JSON.parse(storage.getItem(pointer.key)).outbox, []);
});

test('an accepted atomic follow-up keeps its server-owned children when a later preference edit resumes', async () => {
  const storage = new MemoryStorage();
  let serverBoot = structuredClone(BOOT);
  let serverProfile = structuredClone(PROFILE);
  let followUpCreates = 0;
  let commentWrites = 0;
  let preferencePatches = 0;
  let failPreference = true;
  let visible;
  const statuses = [];
  const request = async (path, options = {}) => {
    if (path === '/api/v1/me' && !options.method) return { data: structuredClone(serverProfile) };
    if (path === '/api/v1/me' && options.method === 'PATCH') {
      preferencePatches += 1;
      if (failPreference) throw new Error('The connection dropped after the follow-up was accepted.');
      serverProfile = { ...serverProfile, prefs: options.body.prefs, user: { ...serverProfile.user, version: 3 } };
      return { data: structuredClone(serverProfile) };
    }
    if (path === '/api/v1/w/synthetic/bootstrap') return { data: structuredClone(serverBoot) };
    if (path === '/api/v1/w/synthetic/directory') return { data: { permissions: { margins: false, contacts: false } } };
    if (path === '/api/v1/me/sessions') return { data: { items: [] } };
    if (path === '/api/v1/w/synthetic/tasks/task-1/follow-ups' && options.method === 'POST') {
      followUpCreates += 1;
      const task = {
        id: 'server-follow-up',
        version: 1,
        key: 'SYN-2',
        kind: 'follow_up',
        projectId: 'project-1',
        title: options.body.title,
        status: 'todo',
        priority: 'medium',
        assigneeId: options.body.assigneeId,
        dueDate: options.body.dueDate,
        description: options.body.note,
        followsUpId: 'task-1',
        followsUpGate: options.body.gate,
        subtasks: [],
        dependencyIds: [],
        attachmentIds: [],
      };
      serverBoot.tasks.push(task);
      serverBoot.comments.push({
        id: 'server-follow-up-comment',
        version: 1,
        taskId: 'task-1',
        authorId: 'user-1',
        body: '<p>Follow-up SYN-2: synthetic</p>',
        reactions: [],
        createdAt: '2026-11-02T12:00:00.000Z',
      });
      serverBoot.notifications.push({
        id: 'server-follow-up-notification',
        version: 1,
        userId: 'user-1',
        actorId: 'user-1',
        taskId: task.id,
        type: 'follow_up',
        text: 'asked you to follow up SYN-1',
        createdAt: '2026-11-02T12:00:00.000Z',
      });
      return { data: structuredClone(task) };
    }
    if (path.includes('/comments/') && ['POST', 'DELETE'].includes(options.method)) {
      commentWrites += 1;
      return { data: null };
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
  first.queueSnapshot({ data: next, prefs: { theme: 'light' } });
  await waitFor(() => assert.equal(statuses.at(-1)?.offline, true));
  first.stop();

  failPreference = false;
  const second = createSync(options);
  await second.start();
  second.stop();

  assert.equal(followUpCreates, 1);
  assert.equal(commentWrites, 0, 'the local placeholder and server-generated comment are never separate writes');
  assert.equal(preferencePatches, 2);
  assert.ok(serverBoot.comments.some(comment => comment.id === 'server-follow-up-comment'));
  const pointer = JSON.parse(storage.getItem('lt.cache.active'));
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
