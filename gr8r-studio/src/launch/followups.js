/* =====================================================================
   LAUNCH — follow-ups (screens doc section 11). A follow-up is a gr8r task
   linked to its line (and gate), assigned to the owner with a due date, and
   announced in the owner's inbox. Pure: the caller adds ids and saves.
   ===================================================================== */

/* Problems with a follow-up form, worded for the form's .err lines; empty when it can be sent. */
export function followUpErrors({ owner, due, today }) {
  const errs = {};
  if (!owner) errs.owner = 'Pick who follows this up.';
  if (!due) errs.due = 'Pick a due date.';
  else if (due < today) errs.due = 'Pick today or a later date.';
  return errs;
}

/* The task, the line comment and the owner's notification for one follow-up.
   gate is { key, name } or null for the whole line; today is the user's local date, YYYY-MM-DD. */
export function buildFollowUp({ line, gate = null, owner, ownerName, due, note = '', by, now, today }) {
  const errs = followUpErrors({ owner, due, today });
  if (Object.keys(errs).length) throw new Error(Object.values(errs).join(' '));
  const about = gate ? gate.name : 'Whole line';
  return {
    task: {
      project: line.project,
      title: `Follow up: ${about} · ${line.title}`,
      status: 'todo',
      assignee: owner,
      due,
      desc: note,
      followUpOf: { task: line.id, gate: gate?.key || null },
      created: now,
      updated: now,
    },
    comment: { task: line.id, by, at: now, text: `Raised a follow-up for ${ownerName}${note ? ': ' + note : ''}`, re: {} },
    notif: { type: 'assign', to: owner, by, text: 'asked you to follow up', snippet: `${about} · ${line.key} · due ${due}`, due, at: now, read: false },
  };
}
