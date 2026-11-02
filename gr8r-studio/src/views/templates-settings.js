/* ---------- Settings · Templates & fields ---------- */
import { esc } from '../core/utils.js';
import { ic } from '../core/icons.js';
import { S } from '../core/store.js';
import { OWNER_TEAMS } from '../features/launch-gates.js';
import { gvPill, templatesList } from '../features/launch-state.js';

const scopeName = { store: 'Per store', 'brand-market': 'Brand × market', brand: 'Brand', line: 'Line' };
const tabs = [
  ['gates', 'Gates'],
  ['fields', 'Fields'],
  ['statuses', 'Statuses'],
  ['legend', 'Legend'],
];

const teamSelect = gate =>
  `<select class="select" data-in="templateGateChange" data-gate="${gate.id}" data-f="ownerTeam" aria-label="Owner team">${OWNER_TEAMS.map(team => `<option value="${team.id}" ${gate.ownerTeam === team.id ? 'selected' : ''}>${esc(team.name)}</option>`).join('')}</select>`;

function valuesEditor(gate) {
  return `<div class="template-values"><h3>Values</h3>${gate.values
    .map(
      (value, index) => `<div class="srow template-value">
        <span class="faint" aria-hidden="true">${ic('grip-vertical', 14)}</span>
        <input class="input" value="${esc(value.name)}" data-blur="templateValueBlur" data-gate="${gate.id}" data-value="${value.id}" data-f="name" aria-label="Value name">
        <select class="select" data-in="templateValueChange" data-gate="${gate.id}" data-value="${value.id}" data-f="tone" aria-label="Value colour">${['green', 'amber', 'red', 'blue', 'violet', 'teal', 'rose', 'orange', 'gray'].map(tone => `<option value="${tone}" ${value.tone === tone ? 'selected' : ''}>${tone[0].toUpperCase() + tone.slice(1)}</option>`).join('')}</select>
        <label class="row template-check"><input type="checkbox" class="toggle" data-in="templateValueChange" data-gate="${gate.id}" data-value="${value.id}" data-f="done" ${value.done ? 'checked' : ''}>Counts as done</label>
        ${gate.id === 'listing' ? `<label class="row template-check"><input type="checkbox" class="toggle" data-in="templateValueChange" data-gate="${gate.id}" data-value="${value.id}" data-f="closesStore" ${value.closesStore ? 'checked' : ''}>Closes store gates</label>` : ''}
        <span class="row template-value-actions">${gvPill({ display: value.name, done: value.done, tone: value.tone }, value)}<button class="ibtn ibtn-xs" data-a="moveTemplateValue" data-gate="${gate.id}" data-value="${value.id}" data-d="-1" ${index ? '' : 'disabled'} aria-label="Move value up">${ic('arrow-up', 13)}</button><button class="ibtn ibtn-xs" data-a="moveTemplateValue" data-gate="${gate.id}" data-value="${value.id}" data-d="1" ${index < gate.values.length - 1 ? '' : 'disabled'} aria-label="Move value down">${ic('arrow-down', 13)}</button></span>
      </div>`,
    )
    .join('')}<button class="btn btn-ghost btn-sm" data-a="addTemplateValue" data-gate="${gate.id}">${ic('plus', 13)}Add value</button></div>`;
}

function gatesTab(template) {
  const selected = template.gates.find(gate => gate.id === S.ui.templateGate) || template.gates[0];
  S.ui.templateGate = selected?.id || null;
  return `<div class="panel template-table"><table class="perm-t"><thead><tr><th>Gate</th><th>Scope</th><th>Owner team</th><th>Due vs opening</th><th>Values</th><th></th></tr></thead><tbody>${template.gates
    .map(
      (gate, index) =>
        `<tr class="${selected?.id === gate.id ? 'selected' : ''}"><td><button class="linkbtn" data-a="editTemplateGate" data-id="${gate.id}">${esc(gate.name)}</button></td><td>${esc(scopeName[gate.scope])}</td><td>${esc(OWNER_TEAMS.find(team => team.id === gate.ownerTeam)?.name || gate.ownerTeam)}</td><td class="num">${gate.dueOffset > 0 ? '+' : ''}${gate.dueOffset} d</td><td>${gate.values.length}</td><td><button class="ibtn ibtn-xs" data-a="moveTemplateGate" data-id="${gate.id}" data-d="-1" ${index ? '' : 'disabled'} aria-label="Move gate up">${ic('arrow-up', 13)}</button><button class="ibtn ibtn-xs" data-a="moveTemplateGate" data-id="${gate.id}" data-d="1" ${index < template.gates.length - 1 ? '' : 'disabled'} aria-label="Move gate down">${ic('arrow-down', 13)}</button></td></tr>`,
    )
    .join('')}</tbody></table></div>
    ${
      selected
        ? `<div class="sblock gate-editor"><h2>Edit ${esc(selected.name)}</h2><div class="settings-grid">
      <label class="field"><span class="label">Name</span><input class="input" value="${esc(selected.name)}" data-blur="templateGateBlur" data-gate="${selected.id}" data-f="name"></label>
      <label class="field"><span class="label">Scope</span><select class="select" data-in="templateGateChange" data-gate="${selected.id}" data-f="scope">${Object.entries(
        scopeName,
      )
        .map(([id, name]) => `<option value="${id}" ${selected.scope === id ? 'selected' : ''}>${name}</option>`)
        .join('')}</select></label>
      <label class="field"><span class="label">Owner team</span>${teamSelect(selected)}</label>
      <label class="field"><span class="label">Due vs opening</span><input class="input num" type="number" value="${selected.dueOffset}" data-in="templateGateChange" data-gate="${selected.id}" data-f="dueOffset"><span class="hint">Days before the store opens. 0 is opening day; positive is after.</span></label>
      <label class="field"><span class="label">Skip rule</span><select class="select" data-in="templateGateChange" data-gate="${selected.id}" data-f="skipRule"><option value="" ${selected.skipRule ? '' : 'selected'}>None</option><option value="us-brand" ${selected.skipRule === 'us-brand' ? 'selected' : ''}>US brands</option><option value="not-listed" ${selected.skipRule === 'not-listed' ? 'selected' : ''}>Not listed in the store</option></select></label>
    </div>${valuesEditor(selected)}</div>`
        : ''
    }`;
}

function fieldsTab(template) {
  const fieldTypes = [
    ['select', 'Select'],
    ['text', 'Text'],
    ['number', 'Number'],
    ['date', 'Date'],
    ['yes-no', 'Yes / no'],
  ];
  return `<div class="sblock"><h2>Classification fields</h2>${template.fields
    .map(
      field =>
        `<div class="srow template-field"><div><b>${esc(field.name)}</b><div class="d">${field.values?.length || 0} values</div></div><div class="row"><select class="select" data-in="templateFieldChange" data-field="${field.id}" data-f="type">${fieldTypes.map(([id, name]) => `<option value="${id}" ${field.type === id ? 'selected' : ''}>${name}</option>`).join('')}</select><input class="input" value="${esc(field.columnGroup)}" data-blur="templateFieldBlur" data-field="${field.id}" data-f="columnGroup" aria-label="Column group"><label class="row template-check"><input type="checkbox" class="toggle" data-in="templateFieldChange" data-field="${field.id}" data-f="shownInGrid" ${field.shownInGrid ? 'checked' : ''}>Shown in grid</label></div></div>`,
    )
    .join('')}</div>`;
}

function statusesTab(template) {
  return `<div class="sblock"><h2>Launch readiness pipeline</h2>${template.statuses
    .map(
      status =>
        `<div class="srow template-status"><input class="input" value="${esc(status.name)}" data-blur="templateStatusBlur" data-status="${status.id}" data-f="name" aria-label="Status name"><select class="select" data-in="templateStatusChange" data-status="${status.id}" data-f="icon" aria-label="Status icon">${['backlog', 'todo', 'progress', 'review', 'done'].map(icon => `<option value="${icon}" ${status.icon === icon ? 'selected' : ''}>${icon}</option>`).join('')}</select></div>`,
    )
    .join('')}</div>`;
}

function legendTab(template) {
  return `<div class="sblock"><h2>Brand-code legend</h2>${template.legend
    .map(
      code =>
        `<div class="srow template-legend"><span class="bc" style="--bc:${code.fill}">${esc(code.name)}</span><input class="input grow" value="${esc(code.meaning)}" data-blur="templateLegendBlur" data-code="${code.id}" data-f="meaning" aria-label="Meaning"><input class="input mono" type="color" value="${code.fill}" data-in="templateLegendChange" data-code="${code.id}" data-f="fill" aria-label="Excel fill"><span class="faint">${esc(code.rule || 'No rule')}</span></div>`,
    )
    .join('')}</div>`;
}

export function templatesSettingsHtml() {
  const templates = templatesList();
  const template = templates.find(item => item.id === (S.ui.templateId || templates[0]?.id));
  if (!template)
    return `<h1>Templates & fields</h1><p class="lead">Gates, values and fields used by launches made from each template.</p><div class="sblock"><p>No templates yet.</p><button class="btn btn-primary" data-a="addGccTemplate">Add GCC store launch</button></div>`;
  S.ui.templateId = template.id;
  S.ui.templateTab ||= 'gates';
  return `<h1>Templates & fields</h1><p class="lead">Gates, values and fields used by launches made from each template.</p>
    <div class="sblock template-summary" style="margin-top:0"><div class="srow"><div><b>${esc(template.name)}</b><div class="d">${template.gates.length} gates · launches keep this versioned vocabulary</div></div><span class="badge accent">Active</span></div></div>
    <div class="alert info">${ic('info', 15)}<span>Changes apply to launches using this template and save as soon as a control changes.</span></div>
    <nav class="tabs settings-tabs" aria-label="Template sections">${tabs.map(([id, name]) => `<button class="tab ${S.ui.templateTab === id ? 'on' : ''}" data-a="set" data-k="templateTab" data-v="${id}">${name}</button>`).join('')}</nav>
    ${S.ui.templateTab === 'gates' ? gatesTab(template) : S.ui.templateTab === 'fields' ? fieldsTab(template) : S.ui.templateTab === 'statuses' ? statusesTab(template) : legendTab(template)}`;
}
