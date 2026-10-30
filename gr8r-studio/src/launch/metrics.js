/* =====================================================================
   LAUNCH — the launch overview and fixture capacity, counted from the lines
   (screens doc sections 6 and 8). Pure functions over plain data, so they
   run the same in the browser, in tests and on the server.

   template.gates[]: { key, name, scope: 'store' | 'line' | 'brand' | 'market',
                       ownerTeam, offset (days vs opening), skipBrandCodes?: [code],
                       values: [{ key, label, done?, tone?, closesStore? }] }
   launch.stores[]:  { code, name, opening: 'YYYY-MM-DD' | null, openingNote? }
   lines[]:          { id, key, title, zone, mainCategory, brandCode, assignee, doubleOf?,
                       values: { <gate key>: <value key>, penetration fields },
                       stores: { <store code>: { <gate key>: <value key>, fixtureType } } }
   A line answers a store's gates only when it has an entry in line.stores.
   ===================================================================== */

export const LISTING = 'listing';
/* Brand codes whose store gates are closed: Grey is dropped vs UAE (spec section 4). */
export const CLOSED_CODES = ['Grey'];
export const AT_RISK_DAYS = 7;
export const PENETRATION = ['penetrationPlan', 'penetrationUaeActual', 'penetrationUaeAll', 'penetrationPlanMoe'];

const DAY = 864e5;
const day = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY;
const isoOf = n => new Date(n * DAY).toISOString().slice(0, 10);
export const daysBetween = (from, to) => day(to) - day(from);
export const addDays = (s, n) => isoOf(day(s) + n);

function valueOf(gate, key) {
  return key == null || key === '' ? null : gate.values.find(v => v.key === key) || { key, label: key };
}

/* A DOUBLE placement shares every brand-level answer with its primary line. */
function primaryOf(line, byId) {
  return line.doubleOf && byId.has(line.doubleOf) ? byId.get(line.doubleOf) : line;
}

/* Every applicable gate answer of one line: per-store gates once per store it answers, the rest once.
   Grey, or a listing value that closes the store (No), closes every gate of that store, listing
   included; a gate skipped for the brand code (US brands skip vendor set-up and ICF) does not apply. */
export function lineGates(line, template, launch, byId = new Map()) {
  const out = [];
  const openings = launch.stores.filter(s => line.stores?.[s.code] && s.opening).map(s => s.opening);
  const firstOpening = openings.length ? openings.sort()[0] : null;
  const shared = primaryOf(line, byId);
  for (const gate of template.gates) {
    if (gate.skipBrandCodes?.includes(line.brandCode)) continue;
    if (gate.scope === 'store') {
      for (const s of launch.stores) {
        const ans = line.stores?.[s.code];
        if (!ans || storeClosed(line, ans, template)) continue;
        out.push(answer(gate, ans[gate.key], s.code, s.opening));
      }
    } else {
      const src = gate.scope === 'line' ? line : shared;
      out.push(answer(gate, src.values?.[gate.key], null, firstOpening));
    }
  }
  return out;
}
function storeClosed(line, ans, template) {
  if (CLOSED_CODES.includes(line.brandCode)) return true;
  const listing = template.gates.find(g => g.key === LISTING);
  return !!(listing && valueOf(listing, ans[LISTING])?.closesStore);
}
function answer(gate, key, store, opening) {
  const v = valueOf(gate, key);
  return { gate, store, value: v, done: !!v?.done, due: opening ? addDays(opening, gate.offset || 0) : null };
}

export function isListed(line, code, template) {
  const listing = template.gates.find(g => g.key === LISTING);
  return !!(listing && line.stores?.[code] && valueOf(listing, line.stores[code][LISTING])?.done);
}

/* Share of a line's applicable gates that are done, 0..1 (null when nothing applies). */
export function readiness(line, template, launch, byId) {
  const gs = lineGates(line, template, launch, byId);
  return gs.length ? gs.filter(g => g.done).length / gs.length : null;
}

const tone = a => a.value?.tone || 'none';
function lateness(a, today) {
  if (a.done || !a.due) return null;
  const left = daysBetween(today, a.due);
  if (left < 0) return { kind: 'late', days: -left };
  if (left <= AT_RISK_DAYS && (tone(a) === 'wait' || tone(a) === 'none')) return { kind: 'risk', days: -left };
  return null;
}

/* Everything the launch overview shows, from one pass over the lines. */
export function launchOverview({ launch, template, lines, followUps = [], today }) {
  const byId = new Map(lines.map(l => [l.id, l]));
  const codes = launch.stores.map(s => s.code);
  const firstOpening =
    launch.stores
      .map(s => s.opening)
      .filter(Boolean)
      .sort()[0] || null;
  const gateRows = new Map();
  /* One row per gate, and per store for per-store gates; a launch-wide gate is due from the first opening. */
  const rowOf = (gate, store) => {
    const k = gate.key + '|' + (store || '');
    if (!gateRows.has(k)) {
      const opening = store ? launch.stores.find(s => s.code === store).opening : firstOpening;
      gateRows.set(k, {
        gate: gate.key,
        name: gate.name,
        ownerTeam: gate.ownerTeam,
        store,
        due: opening ? addDays(opening, gate.offset || 0) : null,
        done: 0,
        applicable: 0,
        late: 0,
      });
    }
    return gateRows.get(k);
  };
  const listed = Object.fromEntries(codes.map(c => [c, 0]));
  const notReady = Object.fromEntries(codes.map(c => [c, 0]));
  const zones = new Map();
  const mix = new Map();
  const pen = new Map();
  const flagged = [];
  let done = 0,
    applicable = 0,
    lateLines = 0;

  for (const line of lines) {
    const gs = lineGates(line, template, launch, byId);
    let late = false,
      worst = null;
    const openStores = new Set();
    for (const a of gs) {
      const r = rowOf(a.gate, a.store);
      r.applicable++;
      applicable++;
      if (a.done) {
        r.done++;
        done++;
      } else if (a.store) openStores.add(a.store);
      const lt = lateness(a, today);
      if (lt?.kind === 'late') {
        r.late++;
        late = true;
      }
      if (lt && (!worst || lt.days > worst.days)) worst = { ...lt, gate: a.gate.key, value: a.value?.key ?? null, store: a.store, due: a.due };
    }
    if (late) lateLines++;
    if (worst) flagged.push({ line: line.id, key: line.key, title: line.title, assignee: line.assignee, ...worst });
    for (const c of openStores) notReady[c]++;

    for (const c of codes) {
      if (!isListed(line, c, template)) continue;
      listed[c]++;
      const z = line.zone || '';
      if (!zones.has(z)) zones.set(z, Object.fromEntries(codes.map(x => [x, 0])));
      zones.get(z)[c]++;
    }
    const bc = line.brandCode || '';
    mix.set(bc, (mix.get(bc) || 0) + 1);
    const cat = line.mainCategory || '';
    if (!pen.has(cat)) pen.set(cat, { category: cat, lines: 0, sums: PENETRATION.map(() => 0), counts: PENETRATION.map(() => 0) });
    const p = pen.get(cat);
    p.lines++;
    PENETRATION.forEach((f, i) => {
      const v = line.values?.[f];
      if (typeof v === 'number' && Number.isFinite(v)) {
        p.sums[i] += v;
        p.counts[i]++;
      }
    });
  }

  const order = new Map(template.gates.map((g, i) => [g.key, i]));
  const storeOrder = new Map(codes.map((c, i) => [c, i]));
  const byGate = [...gateRows.values()].sort(
    (a, b) => order.get(a.gate) - order.get(b.gate) || (storeOrder.get(a.store) ?? -1) - (storeOrder.get(b.store) ?? -1),
  );
  const zoneRows = [...zones.entries()]
    .filter(([z]) => z)
    .map(([zone, counts]) => ({ zone, counts }))
    .sort((a, b) => a.zone.localeCompare(b.zone));
  const zoneTotal = Object.fromEntries(codes.map(c => [c, zoneRows.reduce((n, r) => n + r.counts[c], 0)]));

  return {
    stores: launch.stores.map(s => {
      const left = s.opening ? daysBetween(today, s.opening) : null;
      return {
        code: s.code,
        name: s.name,
        opening: s.opening,
        openingNote: s.openingNote || '',
        daysLeft: left,
        listed: listed[s.code],
        notReady: left != null && left < 0 ? notReady[s.code] : 0,
      };
    }),
    lines: lines.length,
    lateLines,
    readiness: { done, applicable, gates: template.gates.length },
    byGate,
    listedByZone: { rows: zoneRows, total: zoneTotal, offBy: Object.fromEntries(codes.map(c => [c, listed[c] - zoneTotal[c]])) },
    brandCodes: [...mix.entries()].map(([code, count]) => ({ code, count, share: count / lines.length })).sort((a, b) => b.count - a.count),
    penetration: [...pen.values()]
      .filter(p => p.category)
      .sort((a, b) => a.category.localeCompare(b.category))
      .map(p => ({
        category: p.category,
        lines: p.lines,
        ...Object.fromEntries(PENETRATION.map((f, i) => [f, p.counts[i] ? p.sums[i] / p.counts[i] : null])),
        missing: Object.fromEntries(PENETRATION.map((f, i) => [f, p.lines - p.counts[i]])),
      })),
    lateAndAtRisk: flagged.sort((a, b) => (a.kind === b.kind ? b.days - a.days : a.kind === 'late' ? -1 : 1)),
    followUps: followUpsByOwner(followUps, today),
  };
}

/* Open follow-ups per owner, with how many are overdue. */
export function followUpsByOwner(tasks, today) {
  const m = new Map();
  for (const t of tasks) {
    if (t.status === 'done' || !t.assignee) continue;
    const r = m.get(t.assignee) || { owner: t.assignee, open: 0, overdue: 0 };
    r.open++;
    if (t.due && daysBetween(today, t.due) < 0) r.overdue++;
    m.set(t.assignee, r);
  }
  return [...m.values()].sort((a, b) => b.open - a.open);
}

/* Fixture capacity against allocation (screens doc 8.2). capacity[]: { store, category, fixtureType, count }.
   A line allocates one fixture in a store when it answers that store, the store is not closed for it,
   and it names a fixture type; its category is its zone, or its main category when by = 'mainCategory'. */
export function fixtureCapacity({ launch, template, lines, capacity, by = 'zone' }) {
  const codes = launch.stores.map(s => s.code);
  const rows = new Map();
  const rowOf = (category, fixtureType) => {
    const k = category + '|' + fixtureType;
    if (!rows.has(k)) rows.set(k, { category, fixtureType, cells: Object.fromEntries(codes.map(c => [c, { allocated: 0, capacity: null, over: 0 }])) });
    return rows.get(k);
  };
  for (const c of capacity) if (codes.includes(c.store)) rowOf(c.category, c.fixtureType).cells[c.store].capacity = c.count;
  const used = new Set();
  for (const line of lines) {
    const cat = line[by] || '';
    used.add(cat);
    for (const code of codes) {
      const ans = line.stores?.[code];
      if (!ans?.fixtureType || storeClosed(line, ans, template)) continue;
      rowOf(cat, ans.fixtureType).cells[code].allocated++;
    }
  }
  const overByStore = Object.fromEntries(codes.map(c => [c, 0]));
  const out = [...rows.values()].sort((a, b) => a.category.localeCompare(b.category) || a.fixtureType.localeCompare(b.fixtureType));
  for (const r of out)
    for (const code of codes) {
      const cell = r.cells[code];
      if (cell.capacity != null && cell.allocated > cell.capacity) {
        cell.over = cell.allocated - cell.capacity;
        overByStore[code]++;
      }
    }
  const unknown = [...new Set(capacity.filter(c => codes.includes(c.store) && !used.has(c.category)).map(c => c.category))].sort();
  return { rows: out, overByStore, unknownCategories: unknown };
}
