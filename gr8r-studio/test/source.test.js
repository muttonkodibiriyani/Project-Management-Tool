import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { persistFollowUp } from '../src/launch/followups.js';
import { capacityFrom, directorySource, launchMember, launchSource, metricTemplate, overviewFrom, ownerForGate } from '../src/launch/source.js';

const project = {
  id: 'launch-1',
  kind: 'launch',
  templateId: 'template-1',
  marketCode: 'TST',
  stores: [
    { storeId: 'store-north', slot: 1 },
    { storeId: 'store-south', slot: 2 },
  ],
};

const base = () => ({
  projects: [project],
  stores: [
    { id: 'store-south', code: 'STH', name: 'South', openingDate: '2026-12-20' },
    { id: 'store-north', code: 'NTH', name: 'North', openingDate: '2026-12-01' },
  ],
  templates: [{ id: 'template-1', key: 'gcc_store_launch', name: 'GCC store launch' }],
  lists: [
    { id: 'list-listing', key: 'listing', name: 'Listing' },
    { id: 'list-fixture', key: 'fixture_type', name: 'Fixture type' },
    { id: 'list-icf', key: 'icf', name: 'ICF' },
  ],
  options: [
    { id: 'yes', listId: 'list-listing', key: 'yes', label: 'Yes', isDone: true, position: 1 },
    { id: 'no', listId: 'list-listing', key: 'no', label: 'No', closes: 'store', position: 2 },
    { id: 'gondola', listId: 'list-fixture', key: 'gondola', label: 'Gondola', isDone: true, position: 1 },
    { id: 'received', listId: 'list-icf', key: 'received', label: 'Received', isDone: true, position: 1 },
    { id: 'pending', listId: 'list-icf', key: 'pending', label: 'Pending', position: 2 },
  ],
  fields: [
    {
      id: 'f-listing',
      templateId: 'template-1',
      scope: 'line_store',
      key: 'listing',
      label: 'Listing',
      type: 'select',
      listId: 'list-listing',
      position: 1,
      isGate: true,
      ownerTeamId: 'team-brand',
      dueOffsetDays: -120,
    },
    {
      id: 'f-fixture',
      templateId: 'template-1',
      scope: 'line_store',
      key: 'fixture',
      label: 'Fixture',
      type: 'fixture',
      listId: 'list-fixture',
      position: 2,
      isGate: true,
      ownerTeamId: 'team-vm',
      dueOffsetDays: -45,
    },
    {
      id: 'f-icf',
      templateId: 'template-1',
      scope: 'line',
      key: 'icf',
      label: 'Item creation (ICF)',
      type: 'select',
      listId: 'list-icf',
      position: 3,
      isGate: true,
      ownerTeamId: 'team-brand',
      dueOffsetDays: -60,
    },
  ],
  teams: [
    { id: 'team-brand', name: 'Brand team' },
    { id: 'team-vm', name: 'VM / space' },
  ],
  tasks: [],
  lineStores: [],
  capacity: [
    { id: 'cap-north', storeId: 'store-north', category: 'Skincare', fixtureType: 'gondola', count: 10 },
    { id: 'cap-south', storeId: 'store-south', category: 'Skincare', fixtureType: 'gondola', count: 10 },
  ],
  brands: [],
  brandMarkets: [],
  vendors: [],
  contacts: [],
  comments: [],
  notifications: [],
});

function launchOfSize452() {
  const data = base();
  for (let i = 0; i < 452; i++) {
    const id = `line-${i}`;
    data.tasks.push({
      id,
      key: `SYN-${String(i + 1).padStart(3, '0')}`,
      kind: 'line',
      projectId: project.id,
      title: `Synthetic brand ${i + 1}`,
      assigneeId: `owner-${i % 4}`,
      values: { zone: 'Skincare', main_category: 'Beauty', brand_code: 'yellow', icf: i % 2 ? 'pending' : 'received' },
    });
    for (const [storeId, listed] of [
      ['store-north', i < 258],
      ['store-south', i < 213],
    ]) {
      data.lineStores.push({
        id: `${id}-${storeId}`,
        taskId: id,
        storeId,
        values: {
          listing: listed ? 'yes' : 'no',
          fixture: { asWritten: 'Gondola 3FT', type: 'gondola', widthFt: 3, shelves: 4, temporary: false },
        },
      });
    }
  }
  return data;
}

test('the canonical /bootstrap source computes exact dashboard and capacity counts for 452 lines', () => {
  const data = launchOfSize452();
  const started = performance.now();
  const overview = overviewFrom(data, project, '2026-11-02');
  const capacity = capacityFrom(data, project);
  const elapsed = performance.now() - started;

  assert.deepEqual(
    overview.metrics.stores.map(store => [store.code, store.listed]),
    [
      ['NTH', 258],
      ['STH', 213],
    ],
  );
  assert.equal(overview.metrics.lines, 452);
  assert.deepEqual(overview.metrics.readiness, { done: 1168, applicable: 1394, gates: 3 });
  assert.deepEqual(capacity.metrics.overByStore, { NTH: 1, STH: 1 });
  assert.deepEqual(capacity.metrics.rows[0].cells, {
    NTH: { allocated: 258, capacity: 10, over: 248 },
    STH: { allocated: 213, capacity: 10, over: 203 },
  });
  assert.ok(elapsed < 100, `canonical source and metrics took ${elapsed.toFixed(1)} ms`);
});

test('project store slots, task values and lineStores are the only launch shape screens read', () => {
  const data = launchOfSize452();
  const source = launchSource(data, project);
  assert.deepEqual(
    source.launch.stores.map(store => store.code),
    ['NTH', 'STH'],
  );
  assert.equal(source.lines[0].values.icf, 'received');
  assert.equal(source.lines[0].stores.NTH.fixtureType, 'gondola');
  assert.equal(source.lines[300].stores.NTH.listing, 'no');
});

test('the directory joins brands to market distributors, margins and contacts', () => {
  const data = base();
  data.brands = [{ id: 'brand-1', name: 'Synthetic Brand', values: {} }];
  data.vendors = [{ id: 'vendor-1', name: 'Example Distribution', aliases: ['EXD'] }];
  data.brandMarkets = [{ id: 'bm-1', brandId: 'brand-1', marketCode: 'TST', distributorId: 'vendor-1' }];
  data.tasks = [{ id: 'line-1', kind: 'line', projectId: project.id, brandId: 'brand-1' }];
  const authorized = {
    permissions: { margins: true, contacts: true },
    brandMarketMargins: [{ brandMarketId: 'bm-1', margin: 0.45, extraMargin: 0.02, terms: 'Synthetic terms' }],
    contacts: [{ id: 'contact-1', vendorId: 'vendor-1', marketCode: 'TST', name: 'Sample Contact', emails: ['sample@example.test'] }],
  };

  const directory = directorySource(data, authorized);
  assert.equal(directory.brands[0].lineCount, 1);
  assert.equal(directory.brands[0].markets[0].vendor.name, 'Example Distribution');
  assert.equal(directory.brands[0].markets[0].margin.margin, 0.45);
  assert.equal(directory.vendors[0].contacts[0].emails[0], 'sample@example.test');
});

test('restricted directory details cannot leak out of bootstrap or a denied response', () => {
  const data = base();
  data.brands = [{ id: 'brand-1', name: 'Synthetic Brand', values: {} }];
  data.vendors = [{ id: 'vendor-1', name: 'Example Distribution' }];
  data.brandMarkets = [{ id: 'bm-1', brandId: 'brand-1', marketCode: 'TST', distributorId: 'vendor-1' }];
  // A mutation that puts these fields in bootstrap must still not make them visible.
  data.brandMarketMargins = [{ brandMarketId: 'bm-1', margin: 0.99 }];
  data.contacts = [{ id: 'contact-leak', vendorId: 'vendor-1', emails: ['leak@example.test'] }];
  for (const restricted of [
    undefined,
    { permissions: { margins: false, contacts: false }, brandMarketMargins: data.brandMarketMargins, contacts: data.contacts },
  ]) {
    const directory = directorySource(data, restricted);
    assert.equal(directory.brands[0].markets[0].margin, null);
    assert.deepEqual(directory.contacts, []);
    assert.deepEqual(directory.vendors[0].contacts, []);
  }
});

test('canonical member teams choose the gate owner and persist the owner, due date, link, comment and inbox item', () => {
  const data = launchOfSize452();
  data.teams = [{ id: 'team-brand', key: 'brand', name: 'Brand team' }];
  data.members = [
    { user: { id: 'owner-brand', name: 'Synthetic Owner', email: 'owner@example.test', colour: '#123456' }, gr8rRole: 'Member', teams: ['brand'] },
    { user: { id: 'fallback', name: 'Fallback Owner' }, gr8rRole: 'Member', teams: [] },
  ];
  const line = launchSource(data, project).lines[0];
  line.assignee = 'fallback';
  const gate = metricTemplate(data, project).gates.find(item => item.key === 'listing');
  const owner = ownerForGate(data, gate, line, 'fallback');
  assert.equal(owner, 'owner-brand');
  assert.equal(launchMember(data, owner).name, 'Synthetic Owner');

  const persisted = { tasks: [], comments: [], notifications: [] };
  persistFollowUp({
    data: persisted,
    line,
    gate,
    owner,
    ownerName: launchMember(data, owner).name,
    due: '2026-11-07',
    note: 'Synthetic reminder',
    by: 'manager',
    now: 1_793_747_200_000,
    today: '2026-11-02',
    ids: { task: 'follow-up-1', comment: 'comment-1', notification: 'notification-1' },
    key: 'TST-453',
    storeId: 'store-north',
    order: 453,
  });
  const reloaded = JSON.parse(JSON.stringify(persisted));
  assert.deepEqual(
    {
      owner: reloaded.tasks[0].assigneeId,
      due: reloaded.tasks[0].dueDate,
      line: reloaded.tasks[0].followsUpId,
      gate: reloaded.tasks[0].followsUpGate,
      store: reloaded.tasks[0].followsUpStoreId,
      commentTask: reloaded.comments[0].taskId,
      inboxOwner: reloaded.notifications[0].userId,
      inboxDue: reloaded.notifications[0].due,
    },
    {
      owner: 'owner-brand',
      due: '2026-11-07',
      line: line.id,
      gate: 'listing',
      store: 'store-north',
      commentTask: line.id,
      inboxOwner: 'owner-brand',
      inboxDue: '2026-11-07',
    },
  );
  assert.match(reloaded.comments[0].body, /Synthetic Owner/);
});

test('launch pages do not bypass the canonical source for workspace stores, projects or members', () => {
  const page = readFileSync(new URL('../src/pages/launch.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /D\(\)\.(?:stores|projects|members)/);
});
