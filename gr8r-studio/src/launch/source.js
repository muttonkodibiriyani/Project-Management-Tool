/* =====================================================================
   LAUNCH SOURCE — the one adapter from /bootstrap to every launch screen.

   The API model stays canonical here: workspace stores are separate rows,
   project.stores contains { storeId, slot }, field/list/option definitions
   describe gates, and answers live in task.values / task.lineStores[].values.
   Screens and metrics never guess a second launch shape.
   ===================================================================== */
import { fixtureCapacity, launchOverview } from './metrics.js';

const esc = value =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const first = (...values) => values.find(value => value !== undefined && value !== null);
const same = (a, b) => String(a ?? '') === String(b ?? '');
const byPosition = (a, b) => (a.position ?? a.slot ?? 0) - (b.position ?? b.slot ?? 0);

export const isLaunch = project => project?.kind === 'launch';
export const projectIdOf = project => project?.id;
export const taskProjectId = task => first(task?.projectId, task?.project);
export const taskAssigneeId = task => first(task?.assigneeId, task?.assignee);
export const taskDueDate = task => first(task?.dueDate, task?.due);

export function launchProject(data, id) {
  return (data.projects || []).find(project => same(project.id, id)) || null;
}

export function firstLaunchProject(data) {
  return (data.projects || []).find(isLaunch) || null;
}

export function templateFor(data, project) {
  return (data.templates || []).find(template => same(template.id, project?.templateId)) || null;
}

export function launchStores(data, project) {
  const stores = new Map((data.stores || []).map(store => [String(store.id), store]));
  return [...(project?.stores || [])]
    .sort(byPosition)
    .map(link => {
      const store = stores.get(String(link.storeId));
      return store ? { ...store, slot: link.slot } : null;
    })
    .filter(Boolean);
}

/** Workspace store rows plus the launch projects that use each one. */
export function storesDirectorySource(data) {
  const launches = (data.projects || []).filter(isLaunch);
  return (data.stores || []).map(store => ({
    ...store,
    launches: launches.filter(project => project.stores?.some(link => same(link.storeId, store.id))),
  }));
}

/** Both the canonical API member and the legacy demo member become this one shape. */
export function launchMember(data, id) {
  const member = (data.members || []).find(item => same(first(item.user?.id, item.id), id));
  if (!member) return null;
  const user = member.user || member;
  return {
    id: first(user.id, member.id),
    name: first(user.name, member.name, 'Unknown member'),
    email: first(user.email, member.email, ''),
    colour: first(user.colour, user.c, member.colour, member.c, 'var(--gray)'),
    teams: Array.isArray(member.teams) ? member.teams.map(String) : member.team ? [String(member.team)] : [],
    raw: member,
  };
}

/** ownerTeamId is a team id; canonical members hold that team's key. */
export function ownerForGate(data, gate, line, fallback = null) {
  const team = (data.teams || []).find(item => same(item.id, gate?.ownerTeamId));
  const teamKeys = [team?.key, team?.id, gate?.ownerTeamId].filter(Boolean).map(String);
  const member = (data.members || [])
    .map(item => launchMember(data, first(item.user?.id, item.id)))
    .find(item => item?.teams.some(key => teamKeys.includes(key)));
  return member?.id || line?.assignee || fallback;
}

export function fieldsFor(data, project, scope = null) {
  return (data.fields || [])
    .filter(field => !field.templateId || same(field.templateId, project?.templateId))
    .filter(field => !scope || field.scope === scope)
    .sort(byPosition);
}

export function listFor(data, id) {
  return (data.lists || []).find(list => same(list.id, id)) || null;
}

export function optionsFor(data, listId) {
  return (data.options || []).filter(option => same(option.listId, listId) && !option.archived).sort(byPosition);
}

export function optionFor(data, field, key) {
  return optionsFor(data, field?.listId).find(option => same(option.key, key)) || null;
}

export function fieldFor(data, project, key, scope = null) {
  return fieldsFor(data, project, scope).find(field => field.key === key) || null;
}

function semanticTone(option) {
  if (!option) return 'none';
  if (option.isDone) return 'done';
  const label = String(option.label || option.key || '').toLowerCase();
  const colour = String(option.colour || '').toLowerCase();
  if (label.startsWith('late') || colour.includes('red') || colour === '#f4cccc') return 'late';
  if (/pending|not sent|to send|not started|wip|not raised|followed up|tbc/.test(label)) return 'wait';
  if (/shared|countersigned|revised|scheduled|same as/.test(label)) return 'info';
  return 'none';
}

function skipCodes(field) {
  const when = field?.appliesWhen;
  if (Array.isArray(when?.excludeBrandCodes)) return when.excludeBrandCodes;
  if (Array.isArray(when?.not?.in) && ['brand_code', 'brand-code'].includes(when.not.field)) return when.not.in;
  // The default GCC template rule. Custom templates should use appliesWhen.
  return ['vendor_setup', 'icf'].includes(field?.key) ? ['purple', 'blue', 'Purple', 'Blue'] : [];
}

export function metricTemplate(data, project) {
  const teams = new Map((data.teams || []).map(team => [String(team.id), team]));
  return {
    gates: fieldsFor(data, project)
      .filter(field => field.isGate)
      .map(field => ({
        key: field.key,
        name: field.label,
        scope: field.scope === 'line_store' ? 'store' : field.scope === 'brand_market' ? 'market' : field.scope,
        ownerTeam: teams.get(String(field.ownerTeamId))?.name || field.ownerTeamId || '',
        ownerTeamId: field.ownerTeamId || null,
        offset: field.dueOffsetDays || 0,
        skipBrandCodes: skipCodes(field),
        values: optionsFor(data, field.listId).map(option => ({
          key: option.key,
          label: option.label,
          done: !!option.isDone,
          tone: semanticTone(option),
          closesStore: option.closes === 'store',
          colour: option.colour,
        })),
      })),
  };
}

export function metricLaunch(data, project) {
  return {
    stores: launchStores(data, project).map(store => ({
      id: store.id,
      code: store.code,
      name: store.name,
      opening: first(store.openingDate, store.opening),
      openingNote: store.openingNote || '',
    })),
  };
}

function lineStoresOf(data, task) {
  if (Array.isArray(task.lineStores)) return task.lineStores;
  return (data.lineStores || []).filter(row => same(row.taskId, task.id));
}

function selectedValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return first(value.type, value.key, value.value);
  return value;
}

export function launchLines(data, project) {
  const stores = new Map((data.stores || []).map(store => [String(store.id), store]));
  const brands = new Map((data.brands || []).map(brand => [String(brand.id), brand]));
  const rowsByTask = new Map();
  for (const row of data.lineStores || []) {
    const rows = rowsByTask.get(String(row.taskId)) || [];
    rows.push(row);
    rowsByTask.set(String(row.taskId), rows);
  }
  const brandMarkets = new Map((data.brandMarkets || []).map(row => [`${String(row.brandId)}|${row.marketCode}`, row]));
  const storeFields = fieldsFor(data, project, 'line_store');
  return (data.tasks || [])
    .filter(task => task.kind === 'line' && same(taskProjectId(task), project.id) && !task.archived)
    .map(task => {
      const brand = brands.get(String(task.brandId));
      const market = brandMarkets.get(`${String(task.brandId)}|${project.marketCode}`);
      const values = { ...(brand?.values || {}), ...(market?.values || {}), ...(task.values || {}) };
      values.penetrationPlan = first(values.penetrationPlan, values.penetration_plan);
      values.penetrationUaeActual = first(values.penetrationUaeActual, values.penetration_uae_actual);
      values.penetrationUaeAll = first(values.penetrationUaeAll, values.penetration_uae_all_regions);
      values.penetrationPlanMoe = first(values.penetrationPlanMoe, values.penetration_plan_moe);
      const answers = {};
      for (const row of Array.isArray(task.lineStores) ? task.lineStores : rowsByTask.get(String(task.id)) || []) {
        const store = stores.get(String(row.storeId));
        if (!store) continue;
        answers[store.code] = {};
        for (const field of storeFields) answers[store.code][field.key] = selectedValue(row.values?.[field.key]);
        const fixture = row.values?.fixture;
        answers[store.code].fixtureType = selectedValue(fixture);
      }
      return {
        id: task.id,
        key: task.key,
        title: task.title,
        project: project.id,
        brandId: task.brandId,
        brand: brand?.name || task.title,
        zone: first(values.zone, values.area, ''),
        mainCategory: first(values.main_category, values['main-category'], ''),
        brandCode: first(values.brand_code, values['brand-code'], ''),
        assignee: taskAssigneeId(task),
        doubleOf: first(task.doubleOfId, task.doubleOf),
        values,
        stores: answers,
        source: task,
      };
    });
}

export function launchFollowUps(data, project) {
  return (data.tasks || [])
    .filter(task => task.kind === 'follow_up' && same(taskProjectId(task), project.id) && !task.archived)
    .map(task => ({
      id: task.id,
      key: task.key,
      title: task.title,
      status: task.status,
      assignee: taskAssigneeId(task),
      due: taskDueDate(task),
      followsUp: first(task.followsUpId, task.followUpOf?.task),
      gate: first(task.followsUpGate, task.followUpOf?.gate),
      storeId: first(task.followsUpStoreId, task.followUpOf?.storeId),
      source: task,
    }));
}

export function launchSource(data, projectOrId) {
  const project = typeof projectOrId === 'object' ? projectOrId : launchProject(data, projectOrId);
  if (!project || !isLaunch(project)) return null;
  const template = metricTemplate(data, project);
  const launch = metricLaunch(data, project);
  const lines = launchLines(data, project);
  const followUps = launchFollowUps(data, project);
  return { data, project, template, launch, lines, followUps };
}

export function overviewFrom(data, projectOrId, today) {
  const source = launchSource(data, projectOrId);
  return source ? { source, metrics: launchOverview({ ...source, today }) } : null;
}

export function capacityFrom(data, projectOrId, by = 'zone') {
  const source = launchSource(data, projectOrId);
  if (!source) return null;
  const stores = new Map(source.launch.stores.map(store => [String(store.id), store.code]));
  const capacity = (data.capacity || [])
    .filter(row => stores.has(String(row.storeId)))
    .map(row => ({ store: stores.get(String(row.storeId)), category: row.category, fixtureType: row.fixtureType, count: row.count }));
  return { source, metrics: fixtureCapacity({ launch: source.launch, template: source.template, lines: source.lines, capacity, by }) };
}

export function gateState(data, project, line, gateKey, storeId = null) {
  const field = fieldFor(data, project, gateKey);
  if (!field) return { applicable: false, display: 'Not applicable', reason: 'This gate is not in the template.' };
  const task = line.source || line;
  const storeRow = storeId ? lineStoresOf(data, task).find(row => same(row.storeId, storeId)) : null;
  const raw = field.scope === 'line_store' ? storeRow?.values?.[field.key] : line.values?.[field.key];
  const key = selectedValue(raw);
  const option = optionFor(data, field, key);
  return {
    applicable: true,
    key,
    display: option?.label || (key ? String(key) : 'No value'),
    done: !!option?.isDone,
    tone: semanticTone(option),
    colour: option?.colour || null,
    field,
    option,
  };
}

const toneVar = tone =>
  ({ done: 'var(--gv-done)', wait: 'var(--gv-wait)', late: 'var(--gv-late)', info: 'var(--gv-info)', none: 'var(--gv-none)' })[tone] || 'var(--gv-none)';

/** Canonical gate-value component. PRs that add launch views should reuse this. */
export function gvPill(state, { locked = false } = {}) {
  if (!state || state.applicable === false) return `<span class="gv na" data-tip="${esc(state?.reason || 'Not applicable')}">—</span>`;
  const done = !!state.done;
  const colour = state.colour || toneVar(state.tone);
  return `<span class="gv${done ? ' done' : ''}" style="--c:${esc(colour)}">${done ? '<span aria-hidden="true">✓</span>' : '<i></i>'}${esc(state.display || 'No value')}${locked ? '<span aria-hidden="true">⌁</span>' : ''}</span>`;
}

/** Canonical brand-code component. */
export function bcMark(data, project, line) {
  const field = fieldFor(data, project, 'brand_code') || fieldFor(data, project, 'brand-code');
  const key = first(line?.brandCode, line?.values?.brand_code, line?.values?.['brand-code']);
  const option = optionFor(data, field, key);
  if (!key) return '';
  return `<span class="bc bc-${esc(String(key).toLowerCase())}" style="--c:${esc(option?.colour || 'var(--gray)')}" data-tip="${esc(option?.label || key)}"><i></i>${esc(option?.label || key)}</span>`;
}

/**
 * Joins public bootstrap rows to an explicit authorized GET /w/:ws/directory
 * response. Contacts and margins are never inferred from bootstrap.
 */
export function directorySource(data, authorized = null) {
  const lines = (data.tasks || []).filter(task => task.kind === 'line' && !task.archived);
  const brandMarkets = data.brandMarkets || [];
  const vendors = new Map((data.vendors || []).map(vendor => [String(vendor.id), vendor]));
  const permissions = { margins: !!authorized?.permissions?.margins, contacts: !!authorized?.permissions?.contacts };
  const margins = new Map((permissions.margins ? authorized?.brandMarketMargins || [] : []).map(row => [String(row.brandMarketId), row]));
  const contacts = permissions.contacts ? authorized?.contacts || [] : [];
  const brands = (data.brands || []).map(brand => ({
    ...brand,
    lineCount: lines.filter(line => same(line.brandId, brand.id)).length,
    markets: brandMarkets
      .filter(row => same(row.brandId, brand.id))
      .map(row => ({ ...row, vendor: vendors.get(String(row.distributorId)) || null, margin: margins.get(String(row.id)) || row.margin || null })),
  }));
  return {
    brands,
    vendors: (data.vendors || []).map(vendor => ({
      ...vendor,
      markets: [...new Set(brandMarkets.filter(row => same(row.distributorId, vendor.id)).map(row => row.marketCode))],
      brands: brands.filter(brand => brand.markets.some(row => same(row.distributorId, vendor.id))),
      contacts: contacts.filter(contact => same(contact.vendorId, vendor.id)),
    })),
    contacts,
    permissions,
  };
}
