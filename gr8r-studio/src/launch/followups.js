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

/**
 * Applies the pure follow-up result to the in-memory model using canonical API
 * fields and the legacy demo aliases. The server endpoint persists the same
 * task/comment/notification transaction in production.
 */
export function persistFollowUp({ data, line, gate, owner, ownerName, due, note, by, now, today, ids, key, storeId = null, order = 0 }) {
  const made = buildFollowUp({ line, gate, owner, ownerName, due, note, by, now, today });
  const task = {
    ...made.task,
    id: ids.task,
    key,
    kind: 'follow_up',
    projectId: line.project,
    assigneeId: owner,
    dueDate: due,
    followsUpId: line.id,
    followsUpGate: gate?.key || null,
    followsUpStoreId: storeId,
    followUpOf: { task: line.id, gate: gate?.key || null, storeId },
    priority: 'medium',
    labels: [],
    subtasks: [],
    attachments: [],
    deps: [],
    order,
  };
  const comment = {
    ...made.comment,
    id: ids.comment,
    taskId: line.id,
    authorId: by,
    body: made.comment.text,
  };
  const notification = {
    ...made.notif,
    id: ids.notification,
    task: task.id,
    taskId: task.id,
    userId: owner,
  };
  data.tasks.push(task);
  data.comments.push(comment);
  const inbox = data.notifications || data.notifs;
  if (!Array.isArray(inbox)) throw new Error('The owner inbox is not loaded. Reload the workspace and try again.');
  inbox.unshift(notification);
  return { task, comment, notification };
}
