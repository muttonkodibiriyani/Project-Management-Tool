/* ---------- launch data adapters for the gr8r UI ---------- */
import { esc } from '../core/utils.js';
import { D, proj, task, tasksOf } from '../core/store.js';
import { createGccTemplate, fieldById, gateById, gateDueDate, gateState, groupDefinition, readinessForLine } from './launch-gates.js';

export function templatesList() {
  D().templates ||= [createGccTemplate()];
  return D().templates;
}

export const templateById = id => templatesList().find(template => template.id === id) || null;
export const isLaunchProject = project => project?.kind === 'launch' && !!project.templateId;
export const templateForProject = project => (isLaunchProject(project) ? templateById(project.templateId) : null);
export const resolveLine = id => task(id);

export function projectForViewKey(key) {
  if (!key) return null;
  if (key.startsWith('p:')) return proj(key.slice(2));
  if (key.startsWith('sv:')) {
    const view = D().savedViews.find(item => item.id === key.slice(3));
    return view ? proj(view.project) : null;
  }
  return null;
}

export function readinessForTask(line, project = proj(line?.project)) {
  const template = templateForProject(project);
  if (!template) return null;
  return readinessForLine(line, template, project.stores || [], resolveLine);
}

export function groupLabel(group, project) {
  if (!isLaunchProject(project)) return null;
  if (group === 'status') return 'Launch status';
  const definition = groupDefinition(group, templateForProject(project));
  return definition?.name || null;
}

export function fieldValueName(line, field) {
  const id = line?.fields?.[field.id];
  return field.values?.find(value => value.id === id)?.name || 'No value';
}

export function gvPill(state, option) {
  const tone = state?.applicable === false ? 'na' : option?.tone || state?.tone || 'gray';
  const text = state?.display || option?.name || 'No value';
  const done = state?.done || option?.done;
  return `<span class="gv ${tone}${done ? ' done' : ''}">${done ? '<span aria-hidden="true">✓</span>' : '<i></i>'}${esc(text)}</span>`;
}

export function brandCodeMark(line, template = null) {
  const id = line?.fields?.['brand-code'];
  const code = (template?.legend || []).find(item => item.id === id);
  return code ? `<span class="bc" style="--bc:${code.fill}" data-tip="${esc(code.meaning)}">${esc(code.name)}</span>` : '';
}

export function launchDeadlineEvents(project, lines = tasksOf(project.id)) {
  const template = templateForProject(project);
  if (!template) return [];
  return (project.stores || []).flatMap(store =>
    template.gates.flatMap(gate => {
      const date = gateDueDate(store.opening, gate.dueOffset);
      if (!date) return [];
      const open = lines.filter(line => {
        const state = gateState(line, gate, gate.scope === 'store' ? store.code : null, resolveLine);
        return state.applicable && !state.done;
      }).length;
      return [
        {
          id: `gate-${project.id}-${store.code}-${gate.id}`,
          title: `${gate.name} due · ${store.code}`,
          date,
          time: `${open} open`,
          project: project.id,
          launchGate: gate.id,
          store: store.code,
          tone: gate.values.find(value => !value.done)?.tone || 'amber',
        },
      ];
    }),
  );
}

export function launchDeadlineMilestones(project, lines = tasksOf(project.id)) {
  return launchDeadlineEvents(project, lines).map(event => ({
    name: `${event.title} · ${event.time}`,
    date: event.date,
    gate: event.launchGate,
    store: event.store,
  }));
}

export const gateForPop = pop => {
  const project = proj(task(pop.id)?.project);
  return gateById(templateForProject(project), pop.gate);
};

export const fieldForPop = pop => {
  const project = proj(task(pop.id)?.project);
  return fieldById(templateForProject(project), pop.field);
};
