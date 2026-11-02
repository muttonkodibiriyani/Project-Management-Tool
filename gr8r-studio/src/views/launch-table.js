/* ---------- GCC launch line grid ---------- */
import { esc } from '../core/utils.js';
import { task } from '../core/store.js';
import { av, empty, stIcon } from '../ui/helpers.js';
import { fieldValueName, brandCodeMark, gvPill, readinessForTask, resolveLine, templateForProject } from '../features/launch-state.js';
import { gateState, optionById } from '../features/launch-gates.js';

const width = column => (column.kind === 'title' ? 314 : column.kind === 'readiness' ? 104 : column.kind === 'field' ? 142 : 164);

function columns(project, template) {
  const fields = template.fields.filter(field => field.shownInGrid).map(field => ({ kind: 'field', field, label: field.name }));
  const gates = template.gates.flatMap(gate =>
    gate.scope === 'store'
      ? project.stores.map(store => ({ kind: 'gate', gate, store: store.code, label: `${store.code} · ${gate.name}` }))
      : [{ kind: 'gate', gate, store: null, label: gate.name }],
  );
  return [{ kind: 'title', label: 'Brand · line' }, ...fields, ...gates, { kind: 'readiness', label: 'Ready' }];
}

function cell(line, column, project, template) {
  if (column.kind === 'title')
    return `<td class="sticky cellbtn" data-a="openTask" data-id="${line.id}"><span class="row" style="gap:8px">${stIcon(line.status, 13)}<span class="trunc" style="font-weight:450">${esc(line.title)}</span>${brandCodeMark(line, template)}<span class="mono faint" style="font-size:11px;margin-left:auto">${esc(line.key)}</span></span></td>`;
  if (column.kind === 'field') {
    const value = fieldValueName(line, column.field);
    return `<td class="cellbtn" data-a="pop" data-pop="launch-field" data-id="${line.id}" data-field="${column.field.id}" aria-label="${esc(column.field.name)}: ${esc(value)}"><span class="gv gray"><i></i>${esc(value)}</span></td>`;
  }
  if (column.kind === 'gate') {
    const state = gateState(line, column.gate, column.store, resolveLine);
    const option = optionById(column.gate, state.valueId);
    const editable = state.applicable && !state.inherited;
    return `<td class="${editable ? 'cellbtn' : ''}" ${editable ? `data-a="pop" data-pop="gate" data-id="${line.id}" data-gate="${column.gate.id}" ${column.store ? `data-store="${column.store}"` : ''}` : ''} data-tip="${esc(state.reason || `${column.gate.name} · ${column.gate.ownerTeam}`)}" aria-label="${esc(column.label)}: ${esc(state.display)}">${gvPill(state, option)}</td>`;
  }
  const readiness = readinessForTask(line, project);
  return `<td><span class="rdy" aria-label="${readiness.percent}% ready"><span><i style="width:${readiness.percent}%"></i></span><b>${readiness.percent}%</b></span></td>`;
}

export function launchTableHtml(lines, project) {
  const template = templateForProject(project);
  if (!template) return empty('cloud-alert', 'The template did not load', 'Your lines are safe. Try again in a moment.', 'Try again', 'err');
  if (!lines.length)
    return empty(
      'search-x',
      'No lines match these filters',
      'Clear a filter to see more lines.',
      '<button class="btn btn-secondary btn-sm" data-a="clearFilters" data-key="p:' + project.id + '">Clear filters</button>',
    );
  const cols = columns(project, template);
  const totalWidth = cols.reduce((sum, column) => sum + width(column), 0);
  return `<div class="tbl-wrap hide-m launch-grid" data-keep="launch-grid:${project.id}"><table class="tbl" style="width:${totalWidth}px" role="grid" aria-label="Launch lines" aria-rowcount="${lines.length}" aria-colcount="${cols.length}">
    <colgroup>${cols.map(column => `<col style="width:${width(column)}px">`).join('')}</colgroup>
    <thead><tr>${cols.map(column => `<th class="${column.kind === 'title' ? 'sticky' : ''}" scope="col"><div class="thi">${esc(column.label)}</div></th>`).join('')}</tr></thead>
    <tbody>${lines.map(line => `<tr data-ctx="task" data-id="${line.id}">${cols.map(column => cell(line, column, project, template)).join('')}</tr>`).join('')}</tbody>
  </table></div>
  <div class="only-m launch-cards" style="padding:8px 16px 90px">${lines
    .map(line => {
      const readiness = readinessForTask(line, project);
      const listings = project.stores
        .map(store => {
          const gate = template.gates.find(item => item.id === 'listing');
          const state = gateState(line, gate, store.code, id => task(id));
          return `<span>${esc(store.code)} ${gvPill(state, optionById(gate, state.valueId))}</span>`;
        })
        .join('');
      return `<button class="panel launch-card" data-a="openTask" data-id="${line.id}"><span class="row"><b class="grow">${esc(line.title)}</b><span class="mono faint">${esc(line.key)}</span></span><span class="row" style="margin-top:8px;gap:8px">${av(line.assignee, 'sm')}${brandCodeMark(line, template)}<span class="sp"></span><b>${readiness.percent}% ready</b></span><span class="row" style="margin-top:8px;gap:8px">${listings}</span></button>`;
    })
    .join('')}</div>`;
}
