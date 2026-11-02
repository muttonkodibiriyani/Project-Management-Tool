import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.document = { querySelectorAll: () => [] };
const { installDataSync } = await import('../src/core/app-data.js');
const { _saveT, emptyData, registerSync, replaceStoreData, S, save, STORE_KEY } = await import('../src/core/store.js');

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
  user: { id: 'user-1', version: 1, name: 'Synthetic User', email: 'synthetic@example.test' },
  prefs: { theme: 'dark' },
  workspaces: [{ id: 'workspace-1', slug: 'synthetic', name: 'Synthetic workspace' }],
  permissions: { synthetic: { margins: false, contacts: false } },
};

const BOOTSTRAP = {
  changeSeq: 1,
  workspace: { id: 'workspace-1', slug: 'synthetic', name: 'Synthetic workspace' },
  members: [{ user: PROFILE.user, gr8rRole: 'Owner', teams: [], version: 1 }],
  teams: [],
  projects: [{ id: 'project-1', version: 1, key: 'SYN', name: 'Synthetic project', memberIds: ['user-1'] }],
  tasks: [],
  comments: [],
  notifications: [],
  activity: [],
  files: [],
  events: [],
  savedViews: [],
  favourites: [],
};

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' } });

function assertCompatibilityCleared(renders) {
  assert.equal(S.data.ws.id, '');
  assert.deepEqual(S.data.workspaces, []);
  assert.deepEqual(S.data.projects, []);
  assert.equal(S.authorized.launchDirectory, null);
  assert.equal(renders, 0);
}

function installCompatibilityData() {
  replaceStoreData({
    ...emptyData(),
    ws: { id: 'demo-workspace', name: 'Demo workspace', url: 'demo', c: '#1D1C1A', brand: false },
    workspaces: [{ id: 'demo-workspace', name: 'Demo workspace' }],
    projects: [{ id: 'demo-project', name: 'Demo project' }],
  });
  S.authorized.launchDirectory = { contacts: [{ email: 'restricted@example.test' }] };
}

test('the production compatibility workspace starts in memory without restricted directory data', () => {
  assert.ok(S.data.projects.length > 0);
  assert.equal(S.authorized.launchDirectory, null);
});

test('sync installation clears compatibility data before every request and stays empty on failure', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  for (const failure of ['401', 'offline', 'bootstrap']) {
    await t.test(failure, async () => {
      installCompatibilityData();
      let renders = 0;
      let requests = 0;
      globalThis.fetch = async path => {
        requests += 1;
        assertCompatibilityCleared(renders);
        if (failure === '401') return jsonResponse({ status: 401, code: 'unauthorized', detail: 'Sign in again.' }, 401);
        if (failure === 'offline') throw new Error('The network is unavailable.');
        if (path === '/api/v1/me') return jsonResponse(PROFILE);
        return jsonResponse({ status: 503, code: 'bootstrap_unavailable', detail: 'Bootstrap is unavailable.' }, 503);
      };

      const pending = installDataSync({
        storage: new MemoryStorage(),
        render: () => {
          renders += 1;
        },
      });

      assert.equal(requests, 1, 'the first request starts only after the synchronous reset');
      assertCompatibilityCleared(renders);
      await assert.rejects(pending);
      assert.equal(renders, 0);
      assert.deepEqual(S.data.projects, []);
      assert.equal(requests, failure === 'bootstrap' ? 2 : 1);
    });
  }
});

test('the first authenticated bootstrap replaces the cleared compatibility workspace', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  installCompatibilityData();
  let renders = 0;
  let requests = 0;
  const directory = { permissions: { margins: false, contacts: false } };
  globalThis.fetch = async path => {
    requests += 1;
    if (requests === 1) assertCompatibilityCleared(renders);
    if (path === '/api/v1/me') return jsonResponse(PROFILE);
    if (path === '/api/v1/w/synthetic/bootstrap') return jsonResponse(BOOTSTRAP);
    if (path === '/api/v1/w/synthetic/directory') return jsonResponse(directory);
    if (path === '/api/v1/me/sessions') return jsonResponse({ items: [] });
    throw new Error(`Unexpected request: ${path}`);
  };

  const session = await installDataSync({
    storage: new MemoryStorage(),
    render: () => {
      renders += 1;
    },
  });
  session.stop();

  assert.equal(typeof session.queueSnapshot, 'function');
  assert.equal(renders, 1);
  assert.equal(S.data.ws.id, 'workspace-1');
  assert.equal(S.data.projects[0].id, 'project-1');
  assert.deepEqual(S.authorized.launchDirectory, directory);
  assert.equal('authorized' in S.data, false);
});

test('the compatibility workspace and restricted rows are never written to production localStorage', async t => {
  const previousStorage = globalThis.localStorage;
  const storage = new MemoryStorage();
  t.after(() => {
    clearTimeout(_saveT);
    registerSync(null);
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  globalThis.localStorage = storage;
  installCompatibilityData();

  save();
  await new Promise(resolve => setTimeout(resolve, 175));

  assert.equal(storage.getItem(STORE_KEY), null);
  assert.equal(storage.length, 0);
});
