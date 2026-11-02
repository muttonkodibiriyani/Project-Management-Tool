/* Launch dashboard, stores/fixtures, directories and follow-ups. */
import { TODAY, esc, fmtDate, iso } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { D, S, mem } from '../core/store.js';
import { av, empty, progBar } from '../ui/helpers.js';
import { bcMark, capacityFrom, directorySource, launchFollowUps, launchLines, launchStores, metricTemplate, overviewFrom } from '../launch/source.js';

const pct = (done, applicable) => (applicable ? Math.round((done / applicable) * 100) : 0);
const memberName = id => mem(id)?.name || 'Unassigned';
function stat(label, value, detail, project) {
  return `<button class="stat launch-stat" data-a="go" data-r="project" data-id="${project.id}" data-tab="table"><span class="k">${esc(label)}</span><span class="v num">${esc(value)}</span><span class="d">${detail}</span></button>`;
}

function storeCountdown(store, project) {
  const value =
    store.daysLeft == null
      ? store.openingNote || 'Date pending'
      : store.daysLeft === 0
        ? 'Today'
        : store.daysLeft > 0
          ? `${store.daysLeft} days`
          : `Opened ${Math.abs(store.daysLeft)} days ago`;
  const detail = `${store.listed} listed${store.notReady ? ` · <span class="badge red">${store.notReady} lines not ready</span>` : ''}`;
  return stat(`${store.code} · opens ${store.opening ? fmtDate(store.opening) : store.openingNote}`, value, detail, project);
}

function readinessPanel(result) {
  const { source, metrics } = result;
  return `<section class="panel launch-wide"><div class="panel-h"><h2>Readiness by gate</h2><div class="acts"><button class="btn btn-sm btn-ghost" data-a="go" data-r="project" data-id="${source.project.id}" data-tab="board">Board by gate</button></div></div>
    <div class="tbl-wrap"><table class="perm-t launch-table"><thead><tr><th>Gate</th><th>Owner team</th><th>Store</th><th>Due</th><th>Done</th><th>Readiness</th><th>Late</th></tr></thead><tbody>
    ${metrics.byGate
      .map(row => {
        const percent = pct(row.done, row.applicable);
        return `<tr><td><b>${esc(row.name)}</b></td><td>${esc(row.ownerTeam || '—')}</td><td>${esc(row.store || 'All')}</td><td class="num">${row.due ? fmtDate(row.due) : '—'}</td><td class="num">${row.done} / ${row.applicable}</td><td><span class="rdy">${progBar(percent, percent === 100 ? 'green' : '')}<span class="num">${percent}%</span></span></td><td>${row.late ? `<span class="badge red">${row.late}</span>` : '<span class="faint">0</span>'}</td></tr>`;
      })
      .join('')}</tbody></table></div></section>`;
}

function listedPanel(result) {
  const { source, metrics } = result;
  const stores = source.launch.stores;
  return `<section class="panel"><div class="panel-h"><h2>Listed by zone and store</h2></div><div class="tbl-wrap"><table class="perm-t launch-table"><thead><tr><th>Zone</th>${stores.map(store => `<th>${esc(store.code)}</th>`).join('')}</tr></thead><tbody>
    ${metrics.listedByZone.rows.map(row => `<tr><td>${esc(row.zone)}</td>${stores.map(store => `<td class="num">${row.counts[store.code]}</td>`).join('')}</tr>`).join('')}
    <tr class="launch-total"><td><b>Total</b></td>${stores.map(store => `<td class="num"><b>${metrics.listedByZone.total[store.code]}</b></td>`).join('')}</tr>
    <tr class="faint"><td>Check</td>${stores.map(store => `<td>${metrics.listedByZone.offBy[store.code] ? `<span class="badge red">Off by ${metrics.listedByZone.offBy[store.code]}</span>` : `${ic('check', 12)} Matches listed`}</td>`).join('')}</tr>
    </tbody></table></div></section>`;
}

function brandCodePanel(result) {
  const { source, metrics } = result;
  const total = Math.max(1, metrics.lines);
  return `<section class="panel"><div class="panel-h"><h2>Brand-code mix</h2></div><div class="panel-b"><div class="stackbar launch-mix">${metrics.brandCodes.map(row => `<i class="bc-bg-${esc(String(row.code).toLowerCase())}" style="width:${(row.count / total) * 100}%" title="${esc(row.code)}: ${row.count}"></i>`).join('')}</div><div class="stack launch-legend">${metrics.brandCodes.map(row => `<div class="row">${bcMark(source.data, source.project, { brandCode: row.code })}<span class="sp"></span><b class="num">${row.count}</b><span class="faint num">${Math.round(row.share * 100)}%</span></div>`).join('')}</div></div></section>`;
}

function penetrationPanel(metrics) {
  return `<section class="panel"><div class="panel-h"><h2>Penetration by main category</h2></div>${metrics.penetration.length ? `<div class="tbl-wrap"><table class="perm-t launch-table"><thead><tr><th>Category</th><th>Lines</th><th>Plan</th><th>UAE actual</th></tr></thead><tbody>${metrics.penetration.map(row => `<tr><td>${esc(row.category)}</td><td class="num">${row.lines}</td><td class="num">${row.penetrationPlan == null ? '—' : `${Math.round(row.penetrationPlan * 100)}%`}</td><td class="num">${row.penetrationUaeActual == null ? '—' : `${Math.round(row.penetrationUaeActual * 100)}%`}${row.missing.penetrationUaeActual ? `<div class="faint">${row.missing.penetrationUaeActual} without a value</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : empty('chart-column', 'No penetration figures', 'Add Penetration plan values in the grid to compare categories.', '', 'sm')}</section>`;
}

function riskPanel(result) {
  const { source, metrics } = result;
  const gates = new Map(source.template.gates.map(gate => [gate.key, gate]));
  const rows = metrics.lateAndAtRisk.slice(0, 8);
  return `<section class="panel"><div class="panel-h"><h2>Late and at risk</h2><div class="acts">${metrics.lateAndAtRisk.length > 8 ? `<button class="btn btn-sm btn-ghost" data-a="go" data-r="project" data-id="${source.project.id}" data-tab="table">View all ${metrics.lateAndAtRisk.length}</button>` : ''}</div></div>${
    rows.length
      ? rows
          .map(row => {
            const gate = gates.get(row.gate);
            return `<div class="launch-risk"><div class="grow min0"><div class="row"><b class="mono">${esc(row.key)}</b><span class="badge ${row.kind === 'late' ? 'red' : 'amber'}">${row.kind === 'late' ? `${row.days}d late` : 'At risk'}</span></div><div class="trunc">${esc(row.title)}</div><div class="faint">${esc(gate?.name || row.gate)}${row.store ? ` · ${esc(row.store)}` : ''} · due ${fmtDate(row.due)}</div></div>${av(row.assignee, 'sm')}<button class="btn btn-sm btn-secondary" data-a="raiseLaunchFollowUp" data-line="${row.line}" data-gate="${row.gate}" data-store="${row.store || ''}">${ic('bell-ring', 12)}Follow up</button></div>`;
          })
          .join('')
      : empty('circle-check', 'Nothing late or at risk', 'Every gate due in the next 7 days is started.', '', 'sm')
  }</section>`;
}

function followUpPanel(result) {
  const { source, metrics } = result;
  return `<section class="panel"><div class="panel-h"><h2>Open follow-ups by owner</h2><div class="acts"><button class="btn btn-sm btn-ghost" data-a="go" data-r="project" data-id="${source.project.id}" data-tab="followups">View follow-ups</button></div></div><div class="panel-b">${metrics.followUps.length ? metrics.followUps.map(row => `<button class="launch-owner" data-a="go" data-r="project" data-id="${source.project.id}" data-tab="followups">${av(row.owner, 'sm')}<span class="grow trunc">${esc(memberName(row.owner))}</span><span class="owner-bar"><i style="--p:${Math.min(1, row.open / Math.max(...metrics.followUps.map(x => x.open)))}"></i></span><b class="num">${row.open}</b>${row.overdue ? `<span class="badge red">${row.overdue} overdue</span>` : ''}</button>`).join('') : empty('bell-off', 'No open follow-ups', 'Follow-ups raised on lines show up here.', '', 'sm')}</div></section>`;
}

export function launchOverviewHtml(project) {
  const result = overviewFrom(D(), project, iso(TODAY));
  if (!result) return '';
  const { metrics } = result;
  const ready = pct(metrics.readiness.done, metrics.readiness.applicable);
  return `<div class="page launch-overview" style="max-width:1160px;padding-top:22px"><div class="stats launch-stats">${metrics.stores.map(store => storeCountdown(store, project)).join('')}${stat('Lines', String(metrics.lines), `${metrics.lateLines} late`, project)}${stat('Readiness', `${ready}%`, `across ${metrics.readiness.gates} gates`, project)}</div><div class="launch-dashboard"><div class="stack">${readinessPanel(result)}${listedPanel(result)}${brandCodePanel(result)}${penetrationPanel(metrics)}</div><div class="stack">${riskPanel(result)}${followUpPanel(result)}<section class="panel"><div class="panel-h"><h2>About</h2></div><div class="panel-b launch-about">${esc(project.desc || project.description || '')}</div></section></div></div></div>`;
}

function storesTab() {
  const stores = D().stores || [];
  const launches = (D().projects || []).filter(project => project.kind === 'launch');
  return stores.length
    ? `<div class="tbl-wrap launch-page-table"><table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Market</th><th>Role</th><th>Opening</th><th>Launches</th><th>Aliases</th></tr></thead><tbody>${stores
        .map(store => {
          const used = launches.filter(project => project.stores?.some(link => String(link.storeId) === String(store.id)));
          return `<tr><td class="sticky mono"><b>${esc(store.code)}</b></td><td>${esc(store.name)}</td><td><span class="lbl"><i></i>${esc(store.marketCode)}</span></td><td><span class="badge ${store.role === 'launching' ? 'accent' : 'gray'}">${store.role === 'launching' ? 'Launching' : 'Reference'}</span></td><td class="num">${store.openingDate ? fmtDate(store.openingDate) : `<span class="faint">${esc(store.openingNote || 'Not set')}</span>`}</td><td>${used.map(project => `<button class="pillbtn" data-a="go" data-r="project" data-id="${project.id}" data-tab="overview">${esc(project.name)}</button>`).join('') || '—'}</td><td class="faint">${esc((store.aliases || []).join(', ') || '—')}</td></tr>`;
        })
        .join('')}</tbody></table></div>`
    : empty('store', 'No stores yet', 'Add the stores your launches open, with their opening dates.', '');
}

function capacityTab() {
  const project = (D().projects || []).find(item => item.kind === 'launch');
  if (!project) return empty('layout-grid', 'No fixture capacity recorded', 'Create a launch before adding fixture capacity.', '');
  const result = capacityFrom(D(), project);
  const stores = result.source.launch.stores;
  const over = Object.entries(result.metrics.overByStore).filter(([, count]) => count);
  return `${over.length ? `<div class="alert danger"><div><b>${over.reduce((sum, [, count]) => sum + count, 0)} fixture types are over allocated.</b> Move lines to another fixture or raise the capacity.</div></div>` : '<div class="alert ok"><div><b>Every store is within its fixture capacity.</b></div></div>'}<div class="tbl-wrap launch-page-table"><table class="tbl"><thead><tr><th>Category</th><th>Fixture type</th>${stores.map(store => `<th>${esc(store.code)} <span class="faint">allocated / capacity</span></th>`).join('')}</tr></thead><tbody>${result.metrics.rows
    .map(
      row =>
        `<tr><td class="sticky"><b>${esc(row.category || 'Uncategorised')}</b></td><td>${esc(row.fixtureType)}</td>${stores
          .map(store => {
            const cell = row.cells[store.code];
            const percent = cell.capacity ? Math.min(100, Math.round((cell.allocated / cell.capacity) * 100)) : 0;
            return `<td><button class="capc ${cell.over ? 'over' : cell.capacity == null ? 'none' : ''}" data-a="go" data-r="project" data-id="${project.id}" data-tab="table"><span class="num">${cell.allocated} / ${cell.capacity ?? '—'}</span>${progBar(percent, cell.over ? 'red' : '')}${cell.over ? `<span>${ic('triangle-alert', 12)} over by ${cell.over}</span>` : ''}</button></td>`;
          })
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

export function pageStores() {
  const tab = S.ui.params.tab || 'stores';
  return `<div class="page launch-page"><div class="ph"><div><h1>Stores &amp; fixtures</h1><p>Stores, opening dates and fixture capacity for every launch.</p></div></div><nav class="tabs" aria-label="Stores and fixture views"><button class="tab ${tab === 'stores' ? 'on' : ''}" data-a="go" data-r="stores" data-tab="stores">Stores</button><button class="tab ${tab === 'capacity' ? 'on' : ''}" data-a="go" data-r="stores" data-tab="capacity">Capacity</button></nav><div class="launch-page-body">${tab === 'capacity' ? capacityTab() : storesTab()}</div></div>`;
}

function brandRows(directory) {
  const rows = directory.brands.flatMap(brand =>
    (brand.markets.length ? brand.markets : [null]).map(market => {
      const margin = market?.margin?.margin;
      return `<tr><td class="sticky"><b>${esc(brand.name)}</b></td><td>${esc(brand.hostGroup || '—')}</td><td>${esc(market?.marketCode || '—')}</td><td>${esc(market?.vendor?.name || market?.distributorAsWritten || '—')}</td><td class="num">${typeof margin === 'number' ? `${Math.round(margin * 100)}%` : '—'}${market?.margin?.extraMargin ? ` <span class="faint">+${Math.round(market.margin.extraMargin * 100)}%</span>` : ''}</td><td class="num">${brand.lineCount}</td><td>${brand.newBrand ? '<span class="badge accent">New to market</span>' : '—'}</td></tr>`;
    }),
  );
  return `<div class="tbl-wrap launch-page-table"><table class="tbl"><thead><tr><th>Brand</th><th>Host group</th><th>Market</th><th>Distributor</th><th>Margin</th><th>Lines</th><th>New brand</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

function vendorRows(directory) {
  return `<div class="tbl-wrap launch-page-table"><table class="tbl"><thead><tr><th>Vendor</th><th>Aliases</th><th>Markets</th><th>Brands</th><th>Contacts</th></tr></thead><tbody>${directory.vendors.map(vendor => `<tr><td class="sticky"><b>${esc(vendor.name)}</b></td><td class="faint">${esc((vendor.aliases || []).join(', ') || '—')}</td><td>${vendor.markets.map(market => `<span class="lbl"><i></i>${esc(market)}</span>`).join(' ')}</td><td class="num">${vendor.brands.length}</td><td>${vendor.contacts.map(contact => `<div><b>${esc(contact.name || contact.asWritten || 'Contact')}</b><div class="faint">${esc(contact.role || '')}</div></div>`).join('') || '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

function contactRows(directory) {
  const vendors = new Map(directory.vendors.map(vendor => [String(vendor.id), vendor]));
  return `<div class="tbl-wrap launch-page-table"><table class="tbl"><thead><tr><th>Vendor</th><th>Market</th><th>Contact</th><th>Role</th><th>Email</th></tr></thead><tbody>${directory.contacts.map(contact => `<tr><td class="sticky"><b>${esc(vendors.get(String(contact.vendorId))?.name || '—')}</b></td><td>${esc(contact.marketCode || '—')}</td><td>${esc(contact.name || contact.asWritten || '—')}</td><td>${esc(contact.role || '—')}</td><td>${(contact.emails || []).map(email => `<a href="mailto:${esc(email)}">${esc(email)}</a>`).join(', ') || '—'}</td></tr>`).join('')}</tbody></table></div>`;
}

export function pageBrands() {
  const tab = S.ui.params.tab || 'brands';
  const directory = directorySource(D());
  const body = tab === 'vendors' ? vendorRows(directory) : tab === 'contacts' ? contactRows(directory) : brandRows(directory);
  return `<div class="page launch-page"><div class="ph"><div><h1>Brands &amp; vendors</h1><p>Brand master, distributor, margin and contacts by market.</p></div></div><nav class="tabs" aria-label="Brand directory views"><button class="tab ${tab === 'brands' ? 'on' : ''}" data-a="go" data-r="brands" data-tab="brands">Brands <span class="faint">${directory.brands.length}</span></button><button class="tab ${tab === 'vendors' ? 'on' : ''}" data-a="go" data-r="brands" data-tab="vendors">Vendors <span class="faint">${directory.vendors.length}</span></button><button class="tab ${tab === 'contacts' ? 'on' : ''}" data-a="go" data-r="brands" data-tab="contacts">Contacts <span class="faint">${directory.contacts.length}</span></button></nav><div class="launch-page-body">${body}</div></div>`;
}

export function launchFollowUpsHtml(project) {
  const followUps = launchFollowUps(D(), project);
  const lines = new Map(launchLines(D(), project).map(line => [String(line.id), line]));
  if (!followUps.length)
    return `<div class="page" style="max-width:900px;padding-top:22px">${empty('bell-ring', 'No open follow-ups', 'Raise one from any line or gate with Follow up.', '')}</div>`;
  return `<div class="page launch-followups" style="max-width:980px;padding-top:22px"><div class="panel"><div class="panel-h"><h2>Open follow-ups</h2><span class="badge amber">${followUps.filter(item => item.status !== 'done').length} open</span></div><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Follow-up</th><th>Line</th><th>Gate</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead><tbody>${followUps
    .map(item => {
      const line = lines.get(String(item.followsUp));
      const overdue = item.due && item.due < iso(TODAY) && item.status !== 'done';
      return `<tr><td class="sticky"><b>${esc(item.title)}</b><div class="faint mono">${esc(item.key)}</div></td><td><button class="pillbtn" data-a="go" data-r="project" data-id="${project.id}" data-tab="table">${esc(line?.key || 'Line')}</button></td><td>${esc(item.gate || 'Whole line')}</td><td><span class="row">${av(item.assignee, 'sm')}${esc(memberName(item.assignee))}</span></td><td><span class="due ${overdue ? 'over' : ''}">${item.due ? fmtDate(item.due) : 'No due date'}</span></td><td><span class="badge ${item.status === 'done' ? 'green' : 'amber'}">${item.status === 'done' ? 'Done' : 'Open'}</span></td></tr>`;
    })
    .join('')}</tbody></table></div></div></div>`;
}

export function followUpDefaults(project, lineId, gateKey, storeCode) {
  const line = launchLines(D(), project).find(item => String(item.id) === String(lineId));
  const gate = metricTemplate(D(), project).gates.find(item => item.key === gateKey);
  const members = D().members || [];
  const owner = members.find(member => member.team === gate?.ownerTeamId)?.id || line?.assignee || D().me;
  const store = launchStores(D(), project).find(item => item.code === storeCode);
  return { line, gate, owner, store };
}
