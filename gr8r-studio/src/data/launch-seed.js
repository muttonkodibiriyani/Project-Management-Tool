/* Synthetic /bootstrap-shaped launch fixture. No customer workbook data. */
import { TEAMS_SEED } from '../core/constants.js';

const option = (listId, key, label, position, extra = {}) => ({ id: `${listId}-${key}`, listId, key, label, position, ...extra });
const list = (id, name) => ({ id, key: id.replace('list-', ''), name });

export function addSyntheticLaunch({ projects, tasks, dOff, minsAgo }) {
  const teams = [
    ...TEAMS_SEED.map(team => ({ ...team })),
    ['team-brand', 'Brand team', 'tag'],
    ['team-comms', 'Comms', 'messages-square'],
    ['team-commercial', 'Commercial', 'handshake'],
    ['team-registration', 'Registration', 'badge-check'],
    ['team-supply', 'Supply', 'truck'],
    ['team-vm', 'VM / space', 'layout-grid'],
  ].map(team => (Array.isArray(team) ? { id: team[0], name: team[1], icon: team[2], c: '#5A67D8', desc: '' } : team));

  const stores = [
    {
      id: 'store-north',
      code: 'NTH',
      name: 'North Centre',
      mall: 'North Centre',
      city: 'Test City',
      marketCode: 'TST',
      role: 'launching',
      openingDate: dOff(35),
      openingNote: '',
      status: 'planned',
      aliases: [],
    },
    {
      id: 'store-south',
      code: 'STH',
      name: 'South Galleria',
      mall: 'South Galleria',
      city: 'Demo City',
      marketCode: 'TST',
      role: 'launching',
      openingDate: dOff(70),
      openingNote: '',
      status: 'planned',
      aliases: ['SG'],
    },
    {
      id: 'store-reference',
      code: 'REF',
      name: 'Reference Avenue',
      mall: 'Reference Avenue',
      city: 'Sample City',
      marketCode: 'TST',
      role: 'reference',
      openingDate: dOff(-365),
      openingNote: '',
      status: 'open',
      aliases: [],
    },
  ];

  const launch = {
    id: 'p-launch',
    key: 'TST',
    name: 'Synthetic two-store launch',
    icon: 'store',
    color: 'teal',
    colour: 'teal',
    status: 'active',
    team: 'product',
    teamId: 'product',
    lead: 'm1',
    leadId: 'm1',
    due: dOff(70),
    dueDate: dOff(70),
    start: dOff(-30),
    startDate: dOff(-30),
    fav: true,
    favourite: true,
    members: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'],
    memberIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'],
    desc: 'Synthetic pilot data for validating a two-store GCC launch. All names, contacts and figures are fictitious.',
    description: 'Synthetic pilot data for validating a two-store GCC launch. All names, contacts and figures are fictitious.',
    kind: 'launch',
    templateId: 'tpl-gcc',
    marketCode: 'TST',
    stores: [
      { storeId: 'store-north', slot: 1 },
      { storeId: 'store-south', slot: 2 },
    ],
    milestones: [
      { id: 'ms-north', name: 'North Centre opening', date: dOff(35), storeId: 'store-north' },
      { id: 'ms-south', name: 'South Galleria opening', date: dOff(70), storeId: 'store-south' },
    ],
    last: 4,
  };
  projects.push(launch);

  const lists = [
    list('list-status', 'Launch status'),
    list('list-brand-code', 'Brand code'),
    list('list-listing', 'Listing'),
    list('list-comms', 'Vendor comms'),
    list('list-binary-sent', 'Sent state'),
    list('list-vpa', 'Vendor agreement'),
    list('list-registration', 'Registration'),
    list('list-marketing', 'Marketing OK'),
    list('list-setup', 'Vendor set-up'),
    list('list-icf', 'Item creation'),
    list('list-schematics', 'Schematics'),
    list('list-fixture', 'Fixture type'),
    list('list-po', 'Purchase order'),
    list('list-delivery', 'Delivery'),
    list('list-install', 'VM install'),
    list('list-at-launch', 'At launch'),
  ];
  const options = [
    option('list-status', 'proposed', 'Proposed', 1),
    option('list-status', 'confirmed', 'Confirmed', 2),
    option('list-status', 'setting_up', 'Setting up', 3),
    option('list-status', 'ready_for_po', 'Ready for PO', 4),
    option('list-status', 'ordered', 'Ordered', 5),
    option('list-status', 'delivered', 'Delivered', 6),
    option('list-status', 'live', 'Live', 7, { isDone: true }),
    option('list-brand-code', 'purple', 'Purple · US exclusive', 1, { colour: 'var(--violet)' }),
    option('list-brand-code', 'blue', 'Blue · US non-exclusive', 2, { colour: 'var(--blue)' }),
    option('list-brand-code', 'green', 'Green · locally supplied', 3, { colour: 'var(--green)' }),
    option('list-brand-code', 'yellow', 'Yellow · local brand', 4, { colour: 'var(--amber)' }),
    option('list-brand-code', 'grey', 'Grey · dropped', 5, { colour: 'var(--gray)', closes: 'line' }),
    option('list-brand-code', 'tbc', 'TBC', 6, { colour: 'var(--orange)' }),
    option('list-listing', 'yes', 'Yes', 1, { isDone: true, colour: 'var(--green)' }),
    option('list-listing', 'no', 'No', 2, { closes: 'store', colour: 'var(--red)' }),
    option('list-listing', 'tbc', 'TBC', 3, { colour: 'var(--amber)' }),
    option('list-comms', 'not_sent', 'Not sent', 1),
    option('list-comms', 'to_send', 'To send (owner)', 2),
    option('list-comms', 'sent', 'Sent', 3, { isDone: true, colour: 'var(--green)' }),
    option('list-comms', 'late', 'Late', 4, { colour: 'var(--red)' }),
    option('list-binary-sent', 'pending', 'Pending', 1),
    option('list-binary-sent', 'sent', 'Sent', 2, { isDone: true, colour: 'var(--green)' }),
    option('list-vpa', 'pending', 'Pending', 1),
    option('list-vpa', 'shared', 'Shared', 2),
    option('list-vpa', 'signed', 'Signed', 3, { isDone: true, colour: 'var(--green)' }),
    option('list-registration', 'new_to_market', 'New to market', 1),
    option('list-registration', 'under_registration', 'Under registration', 2),
    option('list-registration', 'registered', 'Registered', 3, { isDone: true, colour: 'var(--green)' }),
    option('list-marketing', 'ok', 'OK', 1, { isDone: true, colour: 'var(--green)' }),
    option('list-marketing', 'no', 'No', 2, { colour: 'var(--red)' }),
    option('list-setup', 'not_started', 'Not started', 1),
    option('list-setup', 'wip', 'WIP', 2),
    option('list-setup', 'done', 'Done', 3, { isDone: true, colour: 'var(--green)' }),
    option('list-icf', 'pending', 'Pending', 1),
    option('list-icf', 'received', 'Received', 2, { isDone: true, colour: 'var(--green)' }),
    option('list-icf', 'not_required', 'Not required', 3, { isDone: true, colour: 'var(--green)' }),
    option('list-schematics', 'pending', 'Pending', 1),
    option('list-schematics', 'revised', 'Revised', 2),
    option('list-schematics', 'approved', 'Approved', 3, { isDone: true, colour: 'var(--green)' }),
    option('list-fixture', 'gondola', 'Gondola', 1, { isDone: true, colour: 'var(--green)' }),
    option('list-fixture', 'wall', 'Wall', 2, { isDone: true, colour: 'var(--green)' }),
    option('list-fixture', 'endcap', 'Endcap', 3, { isDone: true, colour: 'var(--green)' }),
    option('list-fixture', 'pod', 'Pod', 4, { isDone: true, colour: 'var(--green)' }),
    option('list-po', 'not_raised', 'Not raised', 1),
    option('list-po', 'pending_prc', 'Pending PRC', 2),
    option('list-po', 'released', 'Released', 3, { isDone: true, colour: 'var(--green)' }),
    option('list-po', 'picked_us_dc', 'Picked at US DC', 4, { isDone: true, colour: 'var(--green)' }),
    option('list-delivery', 'scheduled', 'Scheduled', 1),
    option('list-delivery', 'delivered', 'Delivered', 2, { isDone: true, colour: 'var(--green)' }),
    option('list-install', 'pending', 'Pending', 1),
    option('list-install', 'done', 'Done', 2, { isDone: true, colour: 'var(--green)' }),
    option('list-install', 'graphic_missing', 'Graphic missing', 3, { colour: 'var(--red)' }),
    option('list-at-launch', 'yes', 'Yes', 1, { isDone: true, colour: 'var(--green)' }),
    option('list-at-launch', 'plus_30', '+30 days', 2),
    option('list-at-launch', 'not_coming', 'Not coming', 3),
  ];
  const field = (scope, key, label, type, listId, position, ownerTeamId = null, dueOffsetDays = null, isGate = false, extra = {}) => ({
    id: `field-${key}`,
    templateId: 'tpl-gcc',
    scope,
    key,
    label,
    type,
    listId,
    columnGroup: isGate ? (scope === 'line_store' ? 'Store' : 'Gates') : 'Classification',
    position,
    isGate,
    ownerTeamId,
    dueOffsetDays,
    ...extra,
  });
  const fields = [
    field('line', 'brand_code', 'Brand code', 'select', 'list-brand-code', 1),
    field('line', 'zone', 'Zone', 'text', null, 2),
    field('line', 'main_category', 'Main category', 'text', null, 3),
    field('line', 'penetration_plan', 'Penetration plan', 'number', null, 4),
    field('line', 'penetration_uae_actual', 'Penetration UAE actual', 'number', null, 5),
    field('line_store', 'listing', 'Listing', 'select', 'list-listing', 10, 'team-brand', -120, true),
    field('line_store', 'vendor_comms', 'Vendor comms', 'select', 'list-comms', 11, 'team-comms', -100, true),
    field('line_store', 'floor_plan', 'Floor plan', 'select', 'list-binary-sent', 12, 'team-comms', -90, true),
    field('brand_market', 'vpa', 'Vendor agreement (VPA)', 'select', 'list-vpa', 13, 'team-commercial', -90, true),
    field('brand_market', 'registration', 'Registration / new data set-up', 'select', 'list-registration', 14, 'team-registration', -75, true),
    field('brand', 'marketing_ok', 'Marketing OK', 'select', 'list-marketing', 15, 'mkt', -60, true),
    field('brand_market', 'vendor_setup', 'Vendor set-up', 'select', 'list-setup', 16, 'team-supply', -60, true, {
      appliesWhen: { excludeBrandCodes: ['purple', 'blue'] },
    }),
    field('brand_market', 'icf', 'Item creation (ICF)', 'select', 'list-icf', 17, 'team-brand', -60, true, {
      appliesWhen: { excludeBrandCodes: ['purple', 'blue'] },
    }),
    field('line', 'schematics', 'Schematics', 'select', 'list-schematics', 18, 'team-vm', -45, true),
    field('line_store', 'fixture', 'Fixture', 'fixture', 'list-fixture', 19, 'team-vm', -45, true),
    field('line_store', 'purchase_order', 'Purchase order', 'select', 'list-po', 20, 'team-supply', -30, true),
    field('line_store', 'delivery', 'Delivery', 'select', 'list-delivery', 21, 'team-supply', -10, true),
    field('line_store', 'vm_install', 'VM install', 'select', 'list-install', 22, 'team-vm', -7, true),
    field('line_store', 'at_launch', 'At launch', 'select', 'list-at-launch', 23, 'team-brand', 0, true),
  ];
  const templates = [{ id: 'tpl-gcc', key: 'gcc_store_launch', name: 'GCC store launch', kind: 'launch', statusListId: 'list-status', rules: [] }];

  const vendors = Array.from({ length: 8 }, (_, i) => ({
    id: `vendor-${i + 1}`,
    name: `Sample Distribution ${String.fromCharCode(65 + i)}`,
    aliases: [`SD${i + 1}`],
  }));
  const brands = Array.from({ length: 64 }, (_, i) => ({
    id: `brand-${i + 1}`,
    name: `Sample Brand ${String(i + 1).padStart(2, '0')}`,
    hostGroup: `Portfolio ${String.fromCharCode(65 + (i % 6))}`,
    newBrand: i % 9 === 0,
    newBrandCategory: i % 9 === 0 ? 'New to market' : null,
    values: { marketing_ok: i % 11 === 0 ? 'no' : 'ok' },
  }));
  const brandMarkets = brands.map((brand, i) => ({
    id: `brand-market-${i + 1}`,
    brandId: brand.id,
    marketCode: 'TST',
    distributionStatus: 'active',
    distributorId: vendors[i % vendors.length].id,
    distributorAsWritten: vendors[i % vendors.length].name,
    exclusive: i % 3 === 0 ? 'yes' : 'non_exclusive',
    values: {
      vpa: i % 7 === 0 ? 'pending' : 'signed',
      registration: i % 10 === 0 ? 'under_registration' : 'registered',
      vendor_setup: i % 8 === 0 ? 'wip' : 'done',
      icf: i % 6 === 0 ? 'pending' : 'received',
    },
  }));
  const brandMarketMargins = brandMarkets.map((row, i) => ({
    brandMarketId: row.id,
    margin: 0.35 + (i % 8) * 0.01,
    extraMargin: i % 4 === 0 ? 0.02 : null,
    terms: i % 4 === 0 ? 'Synthetic logistics allowance' : '',
  }));
  const contacts = vendors.flatMap((vendor, i) => [
    {
      id: `contact-${i + 1}`,
      vendorId: vendor.id,
      marketCode: 'TST',
      name: `Contact ${String.fromCharCode(65 + i)}`,
      role: 'Account manager',
      emails: [`contact${i + 1}@example.test`],
      phones: [],
      asWritten: `Contact ${String.fromCharCode(65 + i)}`,
    },
  ]);

  const categories = ['Skincare', 'Make-up', 'Hair', 'Wellness'];
  const zones = ['Prestige', 'Beauty', 'Korean beauty', 'Impulse'];
  const codes = ['yellow', 'purple', 'blue', 'green', 'tbc'];
  const lineStores = [];
  for (let i = 0; i < 452; i++) {
    const id = `line-${i + 1}`;
    const brand = brands[i % brands.length];
    const brandCode = codes[i % codes.length];
    const task = {
      id,
      kind: 'line',
      key: `TST-${String(i + 1).padStart(3, '0')}`,
      project: launch.id,
      projectId: launch.id,
      title: `${brand.name} · ${zones[i % zones.length]}`,
      status: i % 17 === 0 ? 'review' : i % 3 === 0 ? 'progress' : 'todo',
      assignee: `m${(i % 7) + 1}`,
      assigneeId: `m${(i % 7) + 1}`,
      priority: i % 13 === 0 ? 'high' : 'medium',
      due: dOff(35),
      dueDate: dOff(35),
      start: dOff(-20),
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc: '',
      estimate: null,
      created: minsAgo(60 * 24 * 20),
      updated: minsAgo(i % 500),
      order: 1000 + i,
      fav: false,
      recur: null,
      brandId: brand.id,
      doubleOfId: i > 0 && i % 53 === 0 ? `line-${i}` : null,
      values: {
        brand_code: brandCode,
        zone: zones[i % zones.length],
        main_category: categories[i % categories.length],
        schematics: i % 9 === 0 ? 'pending' : 'approved',
        penetration_plan: 0.25 + (i % 20) / 100,
        penetration_uae_actual: i % 5 === 0 ? null : 0.2 + (i % 15) / 100,
      },
      openFollowUps: { total: 0, byGate: {} },
    };
    tasks.push(task);
    const northListed = i < 258;
    const southListed = i < 213;
    const fixtureType = ['gondola', 'wall', 'endcap', 'pod'][i % 4];
    for (const [storeId, listed, slot] of [
      ['store-north', northListed, 1],
      ['store-south', southListed, 2],
    ]) {
      const values = {
        listing: listed ? 'yes' : 'no',
        vendor_comms: listed ? (i % 12 === 0 ? 'not_sent' : 'sent') : 'not_sent',
        floor_plan: listed ? (i % 15 === 0 ? 'pending' : 'sent') : 'pending',
        fixture: { asWritten: fixtureType, type: fixtureType, widthFt: 3, shelves: 4, temporary: false },
        purchase_order: listed ? (i % 10 === 0 ? 'pending_prc' : 'released') : 'not_raised',
        delivery: listed ? (i % 14 === 0 ? 'scheduled' : 'delivered') : 'scheduled',
        vm_install: listed ? (i % 18 === 0 ? 'graphic_missing' : 'done') : 'pending',
        at_launch: listed ? (i % 20 === 0 ? 'plus_30' : 'yes') : 'not_coming',
      };
      const row = { id: `ls-${slot}-${i + 1}`, taskId: id, storeId, values };
      lineStores.push(row);
      task.lineStores ||= [];
      task.lineStores.push(row);
    }
  }

  const followUps = [
    {
      id: 'follow-up-1',
      kind: 'follow_up',
      key: 'TST-453',
      project: launch.id,
      projectId: launch.id,
      title: 'Follow up: Item creation · Sample Brand 01',
      status: 'todo',
      assignee: 'm1',
      assigneeId: 'm1',
      due: dOff(3),
      dueDate: dOff(3),
      followsUpId: 'line-1',
      followsUpGate: 'icf',
      priority: 'medium',
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc: '',
      created: Date.now(),
      updated: Date.now(),
      order: 2000,
    },
    {
      id: 'follow-up-2',
      kind: 'follow_up',
      key: 'TST-454',
      project: launch.id,
      projectId: launch.id,
      title: 'Follow up: Vendor comms · Sample Brand 02',
      status: 'todo',
      assignee: 'm2',
      assigneeId: 'm2',
      due: dOff(-1),
      dueDate: dOff(-1),
      followsUpId: 'line-2',
      followsUpGate: 'vendor_comms',
      followsUpStoreId: 'store-north',
      priority: 'high',
      labels: [],
      subtasks: [],
      attachments: [],
      deps: [],
      desc: '',
      created: Date.now(),
      updated: Date.now(),
      order: 2001,
    },
  ];
  tasks.push(...followUps);

  const capacity = stores.slice(0, 2).flatMap((store, storeIndex) =>
    zones.flatMap((category, categoryIndex) =>
      ['gondola', 'wall', 'endcap', 'pod'].map((fixtureType, fixtureIndex) => ({
        id: `capacity-${storeIndex}-${categoryIndex}-${fixtureIndex}`,
        storeId: store.id,
        category,
        fixtureType,
        count: storeIndex === 0 && category === 'Skincare' && fixtureType === 'gondola' ? 10 : 36,
        source: 'Synthetic fixture plan',
      })),
    ),
  );

  return { teams, stores, templates, lists, options, fields, capacity, brands, brandMarkets, brandMarketMargins, vendors, contacts, lineStores };
}
