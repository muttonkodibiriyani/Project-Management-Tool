/* Launch overview, fixture capacity and follow-ups, on synthetic launches only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureCapacity, launchOverview, readiness } from '../src/launch/metrics.js';
import { buildFollowUp, followUpErrors } from '../src/launch/followups.js';

const TODAY = '2026-10-30';
const template = {
  gates: [
    {
      key: 'listing',
      name: 'Listing',
      scope: 'store',
      ownerTeam: 'brand',
      offset: -120,
      values: [
        { key: 'yes', label: 'Yes', done: true, tone: 'done' },
        { key: 'no', label: 'No', closesStore: true },
        { key: 'tbc', label: 'TBC', tone: 'wait' },
      ],
    },
    {
      key: 'comms',
      name: 'Vendor comms',
      scope: 'store',
      ownerTeam: 'comms',
      offset: -10,
      values: [
        { key: 'notsent', label: 'Not sent', tone: 'wait' },
        { key: 'sent', label: 'Sent', done: true, tone: 'done' },
      ],
    },
    {
      key: 'icf',
      name: 'Item creation (ICF)',
      scope: 'market',
      ownerTeam: 'brand',
      offset: 0,
      skipBrandCodes: ['Purple', 'Blue'],
      values: [
        { key: 'pending', label: 'Pending', tone: 'wait' },
        { key: 'received', label: 'Received', done: true, tone: 'done' },
      ],
    },
    {
      key: 'schematics',
      name: 'Schematics',
      scope: 'line',
      ownerTeam: 'vm',
      offset: 0,
      values: [
        { key: 'pending', label: 'Pending', tone: 'wait' },
        { key: 'approved', label: 'Approved', done: true, tone: 'done' },
      ],
    },
  ],
};

/* Store A opens in 6 days, store B opened 10 days ago. */
const launch = {
  stores: [
    { code: 'STA', name: 'Store A', opening: '2026-11-05' },
    { code: 'STB', name: 'Store B', opening: '2026-10-20' },
  ],
};
const line = (id, f) => ({ id, key: 'SYN-' + id.slice(1), title: 'Brand ' + id, assignee: 'm1', values: {}, stores: {}, ...f });
const lines = [
  // every gate done in both stores
  line('L1', {
    brandCode: 'Yellow',
    zone: 'Skin',
    mainCategory: 'Beauty',
    values: { icf: 'received', schematics: 'approved', penetrationPlan: 0.2 },
    stores: { STA: { listing: 'yes', comms: 'sent', fixtureType: 'Gondola' }, STB: { listing: 'yes', comms: 'sent', fixtureType: 'Gondola' } },
  }),
  // US brand: ICF skipped; comms 4 days late; schematics due in 6 days and pending (at risk)
  line('L2', {
    brandCode: 'Purple',
    zone: 'Skin',
    mainCategory: 'Beauty',
    values: { schematics: 'pending', penetrationPlan: 0.4, penetrationUaeActual: 0.1 },
    stores: { STA: { listing: 'yes', comms: 'notsent', fixtureType: 'Gondola' } },
  }),
  // Grey: store gates closed, so no fixture either; ICF pending and due in 6 days (at risk)
  line('L3', {
    brandCode: 'Grey',
    zone: 'Hair',
    mainCategory: 'Hair',
    values: { icf: 'pending', schematics: 'approved' },
    stores: { STA: { listing: 'yes', comms: 'notsent', fixtureType: 'Wall' } },
  }),
  // DOUBLE of L1: shares its ICF; not listed in A (closes A); comms in B 20 days late
  line('L4', {
    brandCode: 'Yellow',
    zone: 'Makeup',
    doubleOf: 'L1',
    values: { icf: 'pending', schematics: 'approved' },
    stores: { STA: { listing: 'no' }, STB: { listing: 'yes', comms: 'notsent', fixtureType: 'Gondola' } },
  }),
  // no zone: the zone check row is off by one for A
  line('L5', {
    brandCode: 'Yellow',
    values: { icf: 'received', schematics: 'approved' },
    stores: { STA: { listing: 'yes', comms: 'sent', fixtureType: 'Gondola' } },
  }),
];
const followUps = [
  { assignee: 'm1', due: '2026-10-29', status: 'todo' },
  { assignee: 'm1', due: '2026-11-02', status: 'todo' },
  { assignee: 'm2', due: '2026-10-01', status: 'done' },
  { assignee: 'm3', due: null, status: 'progress' },
];

test('overview counts match the synthetic launch', () => {
  const o = launchOverview({ launch, template, lines, followUps, today: TODAY });
  assert.deepEqual(o.stores, [
    { code: 'STA', name: 'Store A', opening: '2026-11-05', openingNote: '', daysLeft: 6, listed: 4, notReady: 0 },
    { code: 'STB', name: 'Store B', opening: '2026-10-20', openingNote: '', daysLeft: -10, listed: 2, notReady: 1 },
  ]);
  assert.equal(o.lines, 5);
  assert.equal(o.lateLines, 2);
  assert.deepEqual(o.readiness, { done: 15, applicable: 19, gates: 4 });
  assert.deepEqual(
    o.byGate.map(r => [r.gate, r.store, r.due, r.done, r.applicable, r.late]),
    [
      ['listing', 'STA', '2026-07-08', 3, 3, 0],
      ['listing', 'STB', '2026-06-22', 2, 2, 0],
      ['comms', 'STA', '2026-10-26', 2, 3, 1],
      ['comms', 'STB', '2026-10-10', 1, 2, 1],
      ['icf', null, '2026-10-20', 3, 4, 0],
      ['schematics', null, '2026-10-20', 4, 5, 0],
    ],
  );
});

test('a line-level gate is late or at risk from the first opening among the stores the line answers', () => {
  // L2 answers only store A: its schematics are due with A, in 6 days, not with B 10 days ago
  const { lateAndAtRisk } = launchOverview({ launch, template, lines: [{ ...lines[1], stores: { STA: { listing: 'yes', comms: 'sent' } } }], today: TODAY });
  assert.deepEqual(
    lateAndAtRisk.map(r => [r.gate, r.kind, r.due]),
    [['schematics', 'risk', '2026-11-05']],
  );
});

test('listed by zone has a check row that catches lines without a zone', () => {
  const { listedByZone } = launchOverview({ launch, template, lines, today: TODAY });
  assert.deepEqual(listedByZone.rows, [
    { zone: 'Hair', counts: { STA: 1, STB: 0 } },
    { zone: 'Makeup', counts: { STA: 0, STB: 1 } },
    { zone: 'Skin', counts: { STA: 2, STB: 1 } },
  ]);
  assert.deepEqual(listedByZone.total, { STA: 3, STB: 2 });
  assert.deepEqual(listedByZone.offBy, { STA: 1, STB: 0 });
});

test('late lines come first by days late, then lines at risk by how soon they are due', () => {
  const { lateAndAtRisk } = launchOverview({ launch, template, lines, today: TODAY });
  assert.deepEqual(
    lateAndAtRisk.map(r => [r.line, r.kind, r.gate, r.store, r.days]),
    [
      ['L4', 'late', 'comms', 'STB', 20],
      ['L2', 'late', 'comms', 'STA', 4],
      ['L3', 'risk', 'icf', null, -6],
    ],
  );
});

test('brand-code mix, penetration averages and follow-ups per owner', () => {
  const o = launchOverview({ launch, template, lines, followUps, today: TODAY });
  assert.deepEqual(
    o.brandCodes.map(b => [b.code, b.count]),
    [
      ['Yellow', 3],
      ['Purple', 1],
      ['Grey', 1],
    ],
  );
  const beauty = o.penetration.find(p => p.category === 'Beauty');
  assert.equal(beauty.lines, 2);
  assert.ok(Math.abs(beauty.penetrationPlan - 0.3) < 1e-9);
  assert.equal(beauty.penetrationUaeActual, 0.1);
  assert.equal(beauty.penetrationUaeAll, null);
  assert.deepEqual(beauty.missing, { penetrationPlan: 0, penetrationUaeActual: 1, penetrationUaeAll: 2, penetrationPlanMoe: 2 });
  assert.deepEqual(o.followUps, [
    { owner: 'm1', open: 2, overdue: 1 },
    { owner: 'm3', open: 1, overdue: 0 },
  ]);
});

test('readiness follows the US-brand, Grey, No and DOUBLE rules', () => {
  const byId = new Map(lines.map(l => [l.id, l]));
  assert.deepEqual(
    lines.map(l => readiness(l, template, launch, byId)),
    [1, 1 / 3, 1 / 2, 3 / 4, 1],
  );
});

test('over-allocated fixtures are flagged', () => {
  const capacity = [
    { store: 'STA', category: 'Skin', fixtureType: 'Gondola', count: 1 },
    { store: 'STA', category: 'Hair', fixtureType: 'Wall', count: 2 },
    { store: 'STB', category: 'Skin', fixtureType: 'Gondola', count: 1 },
    { store: 'STA', category: 'Nail bar', fixtureType: 'Pod', count: 3 },
    { store: 'XXX', category: 'Skin', fixtureType: 'Gondola', count: 9 },
  ];
  const c = fixtureCapacity({ launch, template, lines, capacity });
  assert.deepEqual(
    c.rows.map(r => [r.category, r.fixtureType, r.cells.STA, r.cells.STB]),
    [
      ['', 'Gondola', { allocated: 1, capacity: null, over: 0 }, { allocated: 0, capacity: null, over: 0 }],
      ['Hair', 'Wall', { allocated: 0, capacity: 2, over: 0 }, { allocated: 0, capacity: null, over: 0 }],
      ['Makeup', 'Gondola', { allocated: 0, capacity: null, over: 0 }, { allocated: 1, capacity: null, over: 0 }],
      ['Nail bar', 'Pod', { allocated: 0, capacity: 3, over: 0 }, { allocated: 0, capacity: null, over: 0 }],
      ['Skin', 'Gondola', { allocated: 2, capacity: 1, over: 1 }, { allocated: 1, capacity: 1, over: 0 }],
    ],
  );
  assert.deepEqual(c.overByStore, { STA: 1, STB: 0 });
  assert.deepEqual(c.unknownCategories, ['Nail bar']);
  const byCat = fixtureCapacity({ launch, template, lines, capacity, by: 'mainCategory' });
  assert.deepEqual(byCat.overByStore, { STA: 0, STB: 0 });
});

test('a follow-up is assigned to its owner with its due date, and announced in their inbox', () => {
  const f = buildFollowUp({
    line: { id: 'L2', key: 'SYN-2', title: 'Brand L2', project: 'p9' },
    gate: { key: 'comms', name: 'Vendor comms' },
    owner: 'm4',
    ownerName: 'Sam Example',
    due: '2026-11-02',
    note: 'Chase the deck',
    by: 'm1',
    now: 1,
    today: TODAY,
  });
  assert.deepEqual(f.task, {
    project: 'p9',
    title: 'Follow up: Vendor comms · Brand L2',
    status: 'todo',
    assignee: 'm4',
    due: '2026-11-02',
    desc: 'Chase the deck',
    followUpOf: { task: 'L2', gate: 'comms' },
    created: 1,
    updated: 1,
  });
  assert.equal(f.notif.to, 'm4');
  assert.equal(f.notif.due, '2026-11-02');
  assert.equal(f.notif.snippet, 'Vendor comms · SYN-2 · due 2026-11-02');
  assert.equal(f.comment.text, 'Raised a follow-up for Sam Example: Chase the deck');
});

test('a follow-up needs an owner and a due date from today on', () => {
  assert.deepEqual(followUpErrors({ owner: 'm4', due: TODAY, today: TODAY }), {});
  assert.deepEqual(followUpErrors({ owner: '', due: '2026-10-29', today: TODAY }), {
    owner: 'Pick who follows this up.',
    due: 'Pick today or a later date.',
  });
  assert.throws(() => buildFollowUp({ line: lines[0], owner: null, due: TODAY, today: TODAY }), /Pick who follows this up\./);
});

/* 452 lines over two stores, the size of the Qatar launch, built from i alone. */
function bigLaunch() {
  const zones = ['Skin', 'Makeup', 'Hair', 'Fragrance'];
  return Array.from({ length: 452 }, (_, i) =>
    line('L' + i, {
      brandCode: i % 10 === 0 ? 'Purple' : 'Yellow',
      zone: zones[i % 4],
      mainCategory: zones[i % 4],
      values: { icf: i % 2 ? 'received' : 'pending', schematics: 'approved', penetrationPlan: 0.01 },
      stores: {
        STA: { listing: i % 7 ? 'yes' : 'tbc', comms: 'sent', fixtureType: 'Gondola' },
        STB: { listing: i % 5 ? 'yes' : 'no', comms: i % 3 ? 'sent' : 'notsent', fixtureType: 'Wall' },
      },
    }),
  );
}

test('a launch the size of Qatar counts right and fast', () => {
  const big = bigLaunch();
  const capacity = [{ store: 'STA', category: 'Skin', fixtureType: 'Gondola', count: 100 }];
  const t0 = performance.now();
  const o = launchOverview({ launch, template, lines: big, today: TODAY });
  const c = fixtureCapacity({ launch, template, lines: big, capacity });
  const ms = performance.now() - t0;
  // listed: i % 7 != 0 in A (452 - 65), i % 5 != 0 in B (452 - 91)
  assert.deepEqual(
    o.stores.map(s => s.listed),
    [387, 361],
  );
  // ICF received on odd i, which are never Purple (i % 10 == 0)
  const icf = o.byGate.find(r => r.gate === 'icf');
  assert.deepEqual([icf.done, icf.applicable], [226, 452 - 46]);
  // Skin is i % 4 == 0: 113 lines, all with a Gondola in A
  assert.deepEqual(c.rows.find(r => r.category === 'Skin' && r.fixtureType === 'Gondola').cells.STA, { allocated: 113, capacity: 100, over: 13 });
  assert.ok(ms < 100, `took ${ms.toFixed(1)} ms`);
});
