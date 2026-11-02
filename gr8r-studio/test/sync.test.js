import assert from 'node:assert/strict';
import test from 'node:test';
import { applyChanges, buildMutations, createSync, toLegacyData } from '../src/core/sync.js';

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
  const next = applyChanges(BOOT, [
    { kind: 'task', id: 'task-1', data: { ...BOOT.tasks[0], title: 'Changed' } },
    { kind: 'event', id: 'event-1', data: { id: 'event-1', title: 'Visit' } },
    { kind: 'comment', id: 'comment-1', deleted: true, data: null },
  ]);
  assert.equal(next.tasks[0].title, 'Changed');
  assert.equal(next.events[0].id, 'event-1');
  assert.deepEqual(next.comments, []);
  assert.equal(BOOT.tasks[0].title, 'Synthetic task', 'the cached base is immutable');
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
