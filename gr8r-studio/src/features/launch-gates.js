/* ---------- GCC launch template and pure gate rules ---------- */

const option = (id, name, tone = 'gray', done = false, extra = {}) => ({ id, name, tone, done, ...extra });

export const GCC_TEMPLATE_ID = 'gcc-store-launch';

export const GCC_GATE_DEFINITIONS = [
  {
    id: 'listing',
    name: 'Listing',
    scope: 'store',
    ownerTeam: 'brand-team',
    dueOffset: -120,
    values: [
      option('yes', 'Yes', 'green', true),
      option('no', 'No', 'red', false, { closesStore: true }),
      option('tbc', 'TBC', 'amber'),
      option('late-after-opening', 'Late (after opening)', 'red'),
      option('late-registration', 'Late – registration', 'red'),
      option('other-store-only', 'Other store only', 'blue'),
      option('no-contact', 'No contact', 'gray'),
    ],
  },
  {
    id: 'vendor-comms',
    name: 'Vendor comms',
    scope: 'store',
    ownerTeam: 'comms',
    dueOffset: -100,
    values: [
      option('not-sent', 'Not sent', 'gray'),
      option('to-send', 'To send (owner)', 'amber'),
      option('sent', 'Sent', 'green', true),
      option('late', 'Late', 'red'),
      option('no-contact', 'No contact', 'gray'),
    ],
  },
  {
    id: 'floor-plan',
    name: 'Floor plan',
    scope: 'store',
    ownerTeam: 'comms',
    dueOffset: -90,
    values: [option('pending', 'Pending', 'amber'), option('sent', 'Sent', 'green', true)],
  },
  {
    id: 'vpa',
    name: 'Vendor agreement (VPA)',
    scope: 'brand-market',
    ownerTeam: 'commercial',
    dueOffset: -90,
    values: [
      option('pending', 'Pending', 'amber'),
      option('shared', 'Shared', 'blue'),
      option('countersigned', 'Countersigned', 'teal'),
      option('signed', 'Signed', 'green', true),
    ],
  },
  {
    id: 'registration',
    name: 'Registration / new data set-up',
    scope: 'brand-market',
    ownerTeam: 'registration',
    dueOffset: -75,
    values: [
      option('not-needed', 'Not needed', 'green', true),
      option('new-to-market', 'New to market', 'violet'),
      option('under-registration', 'Under registration', 'blue'),
      option('with-brand-team', 'With brand team', 'amber'),
      option('need-distributor', 'Need distributor', 'orange'),
      option('registered', 'Registered', 'green', true),
      option('late', 'Late', 'red'),
      option('route-brand', 'Route: by brand', 'teal'),
      option('route-retailer', 'Route: by retailer', 'teal'),
    ],
  },
  {
    id: 'marketing-ok',
    name: 'Marketing OK',
    scope: 'brand',
    ownerTeam: 'marketing',
    dueOffset: -60,
    values: [
      option('ok', 'OK', 'green', true),
      option('ok-korean', 'OK – Korean', 'green', true),
      option('ok-celebrity', 'OK – celebrity', 'green', true),
      option('no', 'No', 'red'),
    ],
  },
  {
    id: 'vendor-setup',
    name: 'Vendor set-up',
    scope: 'brand-market',
    ownerTeam: 'supply',
    dueOffset: -60,
    skipRule: 'us-brand',
    values: [
      option('not-started', 'Not started', 'gray'),
      option('wip', 'WIP', 'blue'),
      option('followed-up', 'Followed up (date)', 'amber'),
      option('done', 'Done', 'green', true),
      option('late', 'Late', 'red'),
      option('route-uae', 'Route: extension from UAE', 'teal'),
      option('route-kwt', 'Route: extension from KWT', 'teal'),
      option('route-qat', 'Route: extension from QAT', 'teal'),
      option('route-new-supplier', 'Route: new supplier', 'violet'),
      option('route-retailer', 'Route: retailer creation', 'violet'),
      option('us-brand', 'US brand', 'blue', true),
    ],
  },
  {
    id: 'icf',
    name: 'Item creation (ICF)',
    scope: 'brand-market',
    ownerTeam: 'brand-team',
    dueOffset: -60,
    skipRule: 'us-brand',
    values: [
      option('pending', 'Pending', 'amber'),
      option('received', 'Received', 'green', true),
      option('not-required', 'Not required', 'green', true),
      option('late', 'Late', 'red'),
      option('us-brand', 'US brand', 'blue', true),
    ],
  },
  {
    id: 'schematics',
    name: 'Schematics',
    scope: 'line',
    ownerTeam: 'vm-space',
    dueOffset: -45,
    values: [
      option('pending', 'Pending', 'amber'),
      option('revised', 'Revised', 'blue'),
      option('approved', 'Approved', 'green', true),
      option('same-as-store', 'Same as <store>', 'green', true),
      option('not-required', 'Not required', 'green', true),
      option('dropped', 'Dropped', 'gray'),
    ],
  },
  {
    id: 'fixture',
    name: 'Fixture',
    scope: 'store',
    ownerTeam: 'vm-space',
    dueOffset: -45,
    values: [
      option('gondola', 'Gondola', 'green', true),
      option('wall', 'Wall', 'green', true),
      option('endcap', 'Endcap', 'green', true),
      option('iconic', 'Iconic', 'green', true),
      option('iconic-plus', 'Iconic+', 'green', true),
      option('half-iconic', '½ iconic', 'green', true),
      option('local-iconic', 'Local iconic', 'green', true),
      option('pod', 'Pod', 'green', true),
      option('impulse', 'Impulse', 'green', true),
      option('bay', 'Bay', 'green', true),
      option('bespoke-bay', 'Bespoke bay', 'green', true),
      option('temp-endcap', 'Temp endcap', 'green', true),
      option('lash-endcap', 'Lash endcap', 'green', true),
      option('not-listed', 'Not listed', 'gray'),
    ],
  },
  {
    id: 'purchase-order',
    name: 'Purchase order',
    scope: 'store',
    ownerTeam: 'supply',
    dueOffset: -30,
    values: [
      option('not-raised', 'Not raised', 'gray'),
      option('pending-prc', 'Pending PRC', 'amber'),
      option('released', 'Released', 'green', true),
      option('picked-us-dc', 'Picked at US DC', 'green', true),
      option('awaiting-hb', 'Awaiting HB', 'orange'),
      option('other-store-only', 'Other store only', 'blue'),
    ],
  },
  {
    id: 'delivery',
    name: 'Delivery',
    scope: 'store',
    ownerTeam: 'supply',
    dueOffset: -10,
    values: [option('scheduled', 'Scheduled', 'blue'), option('delivered', 'Delivered', 'green', true)],
  },
  {
    id: 'vm-install',
    name: 'VM install',
    scope: 'store',
    ownerTeam: 'vm-space',
    dueOffset: -7,
    values: [option('done', 'Done', 'green', true), option('trays-missing', 'Trays missing', 'red'), option('graphic-missing', 'Graphic missing', 'red')],
  },
  {
    id: 'at-launch',
    name: 'At launch',
    scope: 'store',
    ownerTeam: 'brand-team',
    dueOffset: 0,
    values: [
      option('yes', 'Yes', 'green', true),
      option('plus-30', '+30 days', 'amber'),
      option('plus-60', '+60 days', 'orange'),
      option('plus-90', '+90 days', 'red'),
      option('plus-120', '+120 days', 'red'),
      option('not-coming', 'Not coming', 'gray'),
    ],
  },
];

export const GCC_STATUSES = [
  ['proposed', 'Proposed', 'backlog'],
  ['confirmed', 'Confirmed', 'todo'],
  ['setting-up', 'Setting up', 'progress'],
  ['ready-for-po', 'Ready for PO', 'review'],
  ['ordered', 'Ordered', 'progress'],
  ['delivered', 'Delivered', 'review'],
  ['live', 'Live', 'done'],
  ['late-after-opening', 'Late (after opening)', 'review'],
  ['dropped', 'Dropped', 'done'],
].map(([id, name, icon]) => ({ id, name, icon }));

export const GCC_FIELDS = [
  ['main-category', 'Main category', ['Make-up', 'Skincare', 'Fragrance', 'Hair', 'Wellness']],
  ['zone', 'Zone', ['Prestige', 'Beauty', 'Korean beauty', 'Fragrance', 'Impulse']],
  ['brand-code', 'Brand code', ['purple', 'blue', 'green', 'yellow', 'grey', 'tbc', 'other', 'late']],
  ['from', 'From', ['local', 'ulta-us']],
  ['market-status', 'Market status', ['new-to-ub', 'already-in-market', 'new-to-me']],
  ['internal-category', 'Internal category', ['korean', 'local-founder', 'ksa-local', 'qat-local', 'mup-artist', 'chinese']],
  ['eighty-brands', 'The 80 brands', ['yes', 'no']],
  ['exclusivity', 'Exclusivity', ['yes', 'no', 'yes-for-months', 'tbc', 'non-exclusive']],
].map(([id, name, values]) => ({
  id,
  name,
  type: 'select',
  shownInGrid: true,
  columnGroup: 'Classification',
  values: values.map(value => ({ id: value, name: humanize(value) })),
}));

export const GCC_BRAND_CODES = [
  ['purple', 'Purple', 'US brand, exclusive', '#E4D2F7', 'us-brand'],
  ['blue', 'Blue', 'US brand, not exclusive', '#CFE2F3', 'us-brand'],
  ['green', 'Green', 'US brand, locally supplied', '#D9EAD3', ''],
  ['yellow', 'Yellow', 'Local brand', '#FFF2CC', ''],
  ['grey', 'Grey', 'Dropped vs UAE', '#D9D9D9', 'closes-stores'],
  ['tbc', 'TBC', 'Listing to be confirmed', '#FCE5CD', ''],
  ['other', 'Other', 'Bespoke bay or temporary endcap', '#EAD1DC', ''],
  ['late', 'Late', 'Arrives after opening', '#F4CCCC', ''],
].map(([id, name, meaning, fill, rule]) => ({ id, name, meaning, fill, rule }));

export const OWNER_TEAMS = [
  ['brand-team', 'Brand team'],
  ['comms', 'Comms'],
  ['commercial', 'Commercial'],
  ['registration', 'Registration'],
  ['marketing', 'Marketing'],
  ['supply', 'Supply'],
  ['vm-space', 'VM / space'],
].map(([id, name]) => ({ id, name }));

function humanize(value) {
  return value
    .split('-')
    .map(word => word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

export function createGccTemplate() {
  return {
    id: GCC_TEMPLATE_ID,
    name: 'GCC store launch',
    version: 1,
    gates: structuredClone(GCC_GATE_DEFINITIONS),
    fields: structuredClone(GCC_FIELDS),
    statuses: structuredClone(GCC_STATUSES),
    legend: structuredClone(GCC_BRAND_CODES),
  };
}

export const gateById = (template, id) => template?.gates?.find(gate => gate.id === id) || null;
export const fieldById = (template, id) => template?.fields?.find(field => field.id === id) || null;
export const optionById = (gate, id) => gate?.values?.find(value => value.id === id) || null;
export const isUsBrand = line => ['purple', 'blue'].includes(line?.fields?.['brand-code']);
export const isDroppedBrand = line => line?.fields?.['brand-code'] === 'grey';

export function rawGateValue(line, gate, storeCode) {
  const value = line?.gates?.[gate.id];
  return gate.scope === 'store' ? value?.[storeCode] || null : value || null;
}

export function gateState(line, gate, storeCode, resolveLine = () => null) {
  const raw = rawGateValue(line, gate, storeCode);
  if (isDroppedBrand(line) && gate.scope === 'store' && gate.id !== 'listing')
    return { applicable: false, valueId: null, display: 'Dropped', reason: 'Grey closes the store’s gates', done: false };

  if (gate.scope === 'store' && gate.id !== 'listing') {
    const listing = line?.gates?.listing?.[storeCode];
    if (listing === 'no') return { applicable: false, valueId: null, display: `Not listed in ${storeCode}`, reason: 'Listing is No', done: false };
  }

  if (isUsBrand(line) && ['vendor-setup', 'icf'].includes(gate.id))
    return { applicable: false, valueId: 'us-brand', display: 'US brand', reason: 'US brands skip this gate', done: true };

  let valueId = isUsBrand(line) && gate.id === 'purchase-order' ? 'picked-us-dc' : raw;
  let inherited = false;
  if (line?.doubleOf && gate.scope !== 'store') {
    const primary = resolveLine(line.doubleOf);
    if (primary) {
      valueId = rawGateValue(primary, gate, storeCode);
      inherited = true;
    }
  }
  const value = optionById(gate, valueId);
  return {
    applicable: true,
    valueId,
    display: value?.name || 'No value',
    reason: inherited ? `Shared with ${line.doubleOf}` : '',
    done: !!value?.done,
    inherited,
    tone: value?.tone || 'gray',
  };
}

export function readinessForLine(line, template, stores, resolveLine = () => null) {
  const states = [];
  for (const gate of template.gates) {
    if (gate.scope === 'store') {
      for (const store of stores) states.push(gateState(line, gate, store.code, resolveLine));
    } else states.push(gateState(line, gate, null, resolveLine));
  }
  const applicable = states.filter(state => state.applicable);
  const done = applicable.filter(state => state.done).length;
  return { done, applicable: applicable.length, percent: applicable.length ? Math.round((done / applicable.length) * 100) : 100 };
}

export function setGateValue(line, gate, storeCode, valueId) {
  if (!optionById(gate, valueId)) throw new Error(`${valueId} is not a value of ${gate.name}`);
  line.gates ||= {};
  if (gate.scope === 'store') {
    if (!storeCode) throw new Error(`${gate.name} needs a store`);
    line.gates[gate.id] ||= {};
    line.gates[gate.id][storeCode] = valueId;
  } else line.gates[gate.id] = valueId;
}

export function valueForGroup(line, group, storeCode, template, resolveLine = () => null) {
  if (group.startsWith('gate:')) {
    const gate = gateById(template, group.slice(5));
    if (!gate) return null;
    const state = gateState(line, gate, storeCode, resolveLine);
    return state.applicable ? state.valueId || '__empty' : '__na';
  }
  if (group.startsWith('field:')) return line?.fields?.[group.slice(6)] || '__empty';
  return line?.[group] ?? '__empty';
}

export function setGroupValue(line, group, storeCode, valueId, template) {
  if (group.startsWith('gate:')) {
    const gate = gateById(template, group.slice(5));
    if (!gate) throw new Error('The selected gate no longer exists');
    setGateValue(line, gate, storeCode, valueId);
    return gate.name;
  }
  if (group.startsWith('field:')) {
    const field = fieldById(template, group.slice(6));
    if (!field?.values?.some(value => value.id === valueId)) throw new Error('The selected field value no longer exists');
    line.fields ||= {};
    line.fields[field.id] = valueId;
    return field.name;
  }
  line[group] = valueId;
  return humanize(group);
}

export function groupDefinition(group, template) {
  if (group.startsWith('gate:')) {
    const gate = gateById(template, group.slice(5));
    return gate ? { ...gate, kind: 'gate' } : null;
  }
  if (group.startsWith('field:')) {
    const field = fieldById(template, group.slice(6));
    return field ? { ...field, kind: 'field' } : null;
  }
  return null;
}

export function gateDueDate(opening, dueOffset) {
  if (!opening || !Number.isFinite(dueOffset)) return null;
  const date = new Date(`${opening}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + dueOffset);
  return date.toISOString().slice(0, 10);
}
