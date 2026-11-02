/* ---------- authenticated workspace cache + API synchronisation ---------- */

const POLL_MS = 30_000;
const CACHE_POINTER_KEY = 'lt.cache.active';
const CACHE_PREFIX = 'lt.cache.v1:';
const RESOURCE_LIST = {
  workspace: 'workspace',
  member: 'members',
  team: 'teams',
  template: 'templates',
  field: 'fields',
  list: 'lists',
  option: 'options',
  store: 'stores',
  capacity: 'capacity',
  project: 'projects',
  milestone: 'milestones',
  task: 'tasks',
  brand: 'brands',
  brandMarket: 'brandMarkets',
  vendor: 'vendors',
  install: 'installs',
  vendorPack: 'vendorPacks',
  brandList: 'brandLists',
  event: 'events',
  visitBrand: 'visitBrands',
  file: 'files',
  comment: 'comments',
  savedView: 'savedViews',
  notification: 'notifications',
};

const json = value => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const time = value => (value ? new Date(value).getTime() : null);
const minutesSince = value => (value ? Math.max(0, Math.round((Date.now() - time(value)) / 60_000)) : null);
const colourName = value => {
  const known = { '#5A67D8': 'indigo', '#3B82C4': 'blue', '#C54B78': 'rose', '#C48A1E': 'amber', '#23918A': 'teal', '#3D8E5F': 'green' };
  return known[value] || value || 'slate';
};
const bytes = value => {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 ** 2).toFixed(1)} MB`;
};

function legacyMember(member) {
  const user = member.user || member;
  return {
    ...user,
    id: user.id,
    role: member.gr8rRole || user.role || 'Member',
    team: member.teams?.[0] || '',
    teams: member.teams || [],
    title: user.title || '',
    c: user.colour || '#6B7280',
    tz: user.timeZone || '—',
    last: minutesSince(user.lastSeenAt),
    version: member.version ?? user.version,
  };
}

function legacyProject(project) {
  return {
    ...project,
    color: colourName(project.colour),
    team: project.teamId,
    lead: project.leadId,
    due: project.dueDate,
    start: project.startDate,
    fav: Boolean(project.favourite),
    members: project.memberIds || [],
    desc: project.description || '',
    last: minutesSince(project.updatedAt),
  };
}

function legacyTask(task) {
  return {
    ...task,
    project: task.projectId,
    assignee: task.assigneeId,
    due: task.dueDate,
    start: task.startDate,
    order: task.sortOrder ?? 0,
    fav: Boolean(task.favourite),
    desc: task.description || '',
    attachments: task.attachmentIds || [],
    deps: task.dependencyIds || [],
    created: time(task.createdAt),
    updated: time(task.updatedAt),
    completedAt: time(task.completedAt),
    recur: typeof task.recur === 'object' ? task.recur?.label || task.recur?.rule || null : task.recur,
    subtasks: task.subtasks || [],
  };
}

function legacyComment(comment) {
  return {
    ...comment,
    task: comment.taskId,
    by: comment.authorId,
    at: time(comment.createdAt),
    text: comment.body,
    re: Object.fromEntries((comment.reactions || []).map(reaction => [reaction.emoji, reaction.userIds || []])),
  };
}

function legacyActivity(activity) {
  return { ...activity, by: activity.actorId, task: activity.taskId, project: activity.projectId, at: time(activity.at), extra: activity.extra || '' };
}

function legacyNotification(notification) {
  return {
    ...notification,
    by: notification.actorId,
    task: notification.taskId,
    at: time(notification.createdAt),
    read: Boolean(notification.readAt),
    snippet: notification.text,
  };
}

function legacyFile(file) {
  return {
    ...file,
    project: file.projectId,
    task: file.taskId,
    by: file.uploadedBy,
    at: time(file.createdAt),
    size: bytes(file.sizeBytes),
    type: file.contentType,
  };
}

/** Map the canonical API snapshot at the single data-layer seam used by the legacy UI. */
export function toLegacyData(base, profile, directory = null, sessions = []) {
  const workspace = base.workspace || profile.workspaces?.[0] || {};
  const workspaces = (profile.workspaces || []).map(item => ({ ...item, c: item.colour || '#1D1C1A', plan: item.plan || '' }));
  const projects = (base.projects || []).map(legacyProject);
  const favourites = new Set((base.favourites || []).map(item => `${item.kind}:${item.id}`));
  for (const project of projects) project.fav ||= favourites.has(`project:${project.id}`);
  const tasks = (base.tasks || []).map(legacyTask);
  for (const task of tasks) task.fav ||= favourites.has(`task:${task.id}`);
  const events = (base.events || []).map(event => ({ ...event, project: event.projectId, time: event.timeText || '' }));
  const views = (base.savedViews || []).map(view => ({ ...view, project: view.projectId, ...(view.config || {}) }));
  return {
    ...base,
    ws: { ...workspace, url: workspace.slug || '', c: workspace.colour || '#1D1C1A', brand: true },
    workspaces,
    me: profile.user.id,
    members: (base.members || []).map(legacyMember),
    projects,
    tasks,
    comments: (base.comments || []).map(legacyComment),
    activity: (base.activity || []).map(legacyActivity),
    notifs: (base.notifications || []).map(legacyNotification),
    files: (base.files || []).map(legacyFile),
    events,
    savedViews: views,
    projOrder: projects.map(project => project.id),
    sessions,
    recentSearches: [],
    invoices: [],
    notifPrefs: profile.prefs?.notifications || {},
    authorized: directory ? { launchDirectory: directory } : {},
  };
}

/** Apply one ordered /changes page to a canonical bootstrap snapshot. */
export function applyChanges(base, items) {
  const next = json(base);
  for (const item of items) {
    if (item.kind === 'lineStore' || item.kind === 'subtask') {
      const property = item.kind === 'lineStore' ? 'lineStores' : 'subtasks';
      for (const task of next.tasks || []) {
        const rows = Array.isArray(task[property]) ? task[property] : [];
        task[property] = rows.filter(row => String(row.id) !== String(item.id));
      }
      if (!item.deleted && item.data) {
        const task = (next.tasks || []).find(row => String(row.id) === String(item.data.taskId));
        if (task) task[property].push(item.data);
      }
      continue;
    }
    const list = RESOURCE_LIST[item.kind];
    if (!list) continue;
    if (list === 'workspace') {
      if (!item.deleted && item.data) next.workspace = item.data;
      continue;
    }
    const rows = Array.isArray(next[list]) ? next[list] : [];
    const index = rows.findIndex(row => String(item.kind === 'member' ? row.user?.id : row.id) === String(item.id));
    if (item.deleted || !item.data) {
      if (index >= 0) rows.splice(index, 1);
    } else if (index >= 0) rows[index] = item.data;
    else rows.push(item.data);
    next[list] = rows;
  }
  return next;
}

function cacheKey(profile, workspace) {
  return `${CACHE_PREFIX}${profile.user.id}:${workspace.id}`;
}

function withoutRestricted(data) {
  const safe = json(data);
  delete safe.authorized;
  delete safe.contacts;
  delete safe.brandMarketMargins;
  return safe;
}

function parse(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // A full or disabled cache never blocks the in-memory application.
  }
}

function clearCaches(storage) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) if (key?.startsWith(CACHE_PREFIX)) storage.removeItem(key);
  storage.removeItem(CACHE_POINTER_KEY);
}

const indexById = rows => new Map((rows || []).map(row => [String(row.id), row]));
const changed = (before, after, fields) =>
  Object.fromEntries(fields.filter(field => !same(before?.[field], after?.[field])).map(field => [field, after[field]]));
const versionOf = row => row?.version;

/**
 * Replace offline-only ids with the durable ids returned by successful creates.
 * A restart re-bootstraps server rows before rebuilding an outbox diff. Without
 * this seam the accepted server row looks deleted while its local-id twin looks
 * newly created, so the resumed diff can delete the accepted row.
 */
function reconcileSnapshotIds(snapshot, mappings = {}) {
  if (!snapshot || Object.keys(mappings).length === 0) return snapshot;
  const next = json(snapshot);
  const mapped = value => (value === null || value === undefined ? value : mappings[String(value)] || value);
  const mapList = values => (Array.isArray(values) ? values.map(mapped) : values);

  for (const project of next.projects || []) project.id = mapped(project.id);
  for (const task of next.tasks || []) {
    task.id = mapped(task.id);
    task.project = mapped(task.project);
    task.projectId = mapped(task.projectId);
    task.followsUpId = mapped(task.followsUpId);
    if (task.followUpOf) task.followUpOf.task = mapped(task.followUpOf.task);
    task.deps = mapList(task.deps);
    task.dependencyIds = mapList(task.dependencyIds);
    for (const subtask of task.subtasks || []) {
      subtask.id = mapped(subtask.id);
      subtask.taskId = mapped(subtask.taskId);
    }
    for (const lineStore of task.lineStores || []) lineStore.taskId = mapped(lineStore.taskId);
  }
  for (const comment of next.comments || []) {
    comment.id = mapped(comment.id);
    comment.task = mapped(comment.task);
    comment.taskId = mapped(comment.taskId);
    comment.followUpTaskId = mapped(comment.followUpTaskId);
  }
  for (const event of next.events || []) {
    event.id = mapped(event.id);
    event.project = mapped(event.project);
    event.projectId = mapped(event.projectId);
  }
  for (const view of next.savedViews || []) {
    view.id = mapped(view.id);
    view.project = mapped(view.project);
    view.projectId = mapped(view.projectId);
  }
  for (const file of next.files || []) {
    file.project = mapped(file.project);
    file.projectId = mapped(file.projectId);
    file.task = mapped(file.task);
    file.taskId = mapped(file.taskId);
  }
  for (const notification of next.notifs || next.notifications || []) {
    notification.task = mapped(notification.task);
    notification.taskId = mapped(notification.taskId);
  }
  return next;
}

function projectBody(project, create) {
  const body = {
    name: project.name,
    description: project.desc ?? project.description ?? '',
    launchCode: project.launchCode ?? null,
    marketCode: project.marketCode ?? null,
    icon: project.icon || 'folder',
    colour: project.colour || project.color || 'slate',
    status: project.status || 'planning',
    teamId: project.team || project.teamId || null,
    leadId: project.lead || project.leadId || null,
    startDate: project.start || project.startDate || null,
    dueDate: project.due || project.dueDate || null,
    private: Boolean(project.private),
    archived: Boolean(project.archived),
  };
  if (create) Object.assign(body, { key: project.key, kind: project.kind || 'general' });
  return body;
}

function taskBody(task, create, resolve) {
  const body = {
    title: task.title,
    description: task.desc ?? task.description ?? '',
    status: task.status || 'todo',
    priority: task.priority || 'none',
    assigneeId: task.assignee || task.assigneeId || null,
    startDate: task.start || task.startDate || null,
    dueDate: task.due || task.dueDate || null,
    labels: task.labels || [],
    estimate: task.estimate || null,
    recur: task.recur ? (typeof task.recur === 'object' ? task.recur : { label: task.recur }) : null,
    sortOrder: task.order ?? task.sortOrder ?? 0,
    archived: Boolean(task.archived),
  };
  if (create) Object.assign(body, { projectId: resolve(task.project || task.projectId), kind: task.kind || 'task' });
  return body;
}

/** Produce ordered writes from the visible legacy state. Exported for deterministic contract tests. */
export function buildMutations(before, after, prefsBefore = {}, prefsAfter = {}) {
  const operations = [];
  const atomicFollowUps = new Set(
    (after?.tasks || [])
      .filter(task => task.kind === 'follow_up' && (task.followsUpId || task.followUpOf?.task) && !(before?.tasks || []).some(row => row.id === task.id))
      .map(task => String(task.id)),
  );
  const collections = [
    ['project', 'projects'],
    ['task', 'tasks'],
    ['comment', 'comments'],
    ['event', 'events'],
    ['view', 'savedViews'],
  ];
  for (const [resource, key] of collections) {
    const oldRows = indexById(before?.[key]);
    const newRows = indexById(after?.[key]);
    for (const row of newRows.values()) {
      const old = oldRows.get(String(row.id));
      if (!old && resource === 'task' && atomicFollowUps.has(String(row.id))) operations.push({ resource: 'followUp', action: 'create', row });
      else if (!old && resource === 'comment' && atomicFollowUps.has(String(row.followUpTaskId))) continue;
      else if (!old || !same(old, row)) operations.push({ resource, action: old ? 'update' : 'create', before: old, row });
    }
    for (const row of oldRows.values()) if (!newRows.has(String(row.id))) operations.push({ resource, action: 'delete', before: row, row });
  }
  for (const resource of ['project', 'task']) {
    const key = resource === 'project' ? 'projects' : 'tasks';
    const oldRows = indexById(before?.[key]);
    for (const row of after?.[key] || []) {
      const old = oldRows.get(String(row.id));
      if (old && Boolean(old.fav) !== Boolean(row.fav)) operations.push({ resource: 'favourite', action: row.fav ? 'create' : 'delete', kind: resource, row });
    }
  }
  const oldTasks = indexById(before?.tasks);
  for (const task of after?.tasks || []) {
    const oldTask = oldTasks.get(String(task.id));
    const oldSubs = indexById(oldTask?.subtasks);
    const newSubs = indexById(task.subtasks);
    for (const subtask of newSubs.values())
      if (!oldSubs.has(String(subtask.id)) || !same(oldSubs.get(String(subtask.id)), subtask))
        operations.push({
          resource: 'subtask',
          action: oldSubs.has(String(subtask.id)) ? 'update' : 'create',
          before: oldSubs.get(String(subtask.id)),
          row: subtask,
          task,
        });
    for (const subtask of oldSubs.values())
      if (!newSubs.has(String(subtask.id))) operations.push({ resource: 'subtask', action: 'delete', before: subtask, row: subtask, task });
    const oldDeps = new Set(oldTask?.deps || []);
    const newDeps = new Set(task.deps || []);
    for (const dependency of newDeps) if (!oldDeps.has(dependency)) operations.push({ resource: 'dependency', action: 'create', row: task, dependency });
    for (const dependency of oldDeps) if (!newDeps.has(dependency)) operations.push({ resource: 'dependency', action: 'delete', row: task, dependency });
  }
  const oldComments = indexById(before?.comments);
  for (const comment of after?.comments || []) {
    const old = oldComments.get(String(comment.id));
    if (!old) continue;
    const emojis = new Set([...Object.keys(old.re || {}), ...Object.keys(comment.re || {})]);
    for (const emoji of emojis) {
      const had = (old.re?.[emoji] || []).includes(before?.me);
      const has = (comment.re?.[emoji] || []).includes(after?.me);
      if (had !== has) operations.push({ resource: 'reaction', action: has ? 'create' : 'delete', row: comment, emoji });
    }
  }
  for (const row of after?.notifs || []) {
    const old = (before?.notifs || []).find(item => item.id === row.id);
    if (old && (old.read !== row.read || old.archived !== row.archived)) operations.push({ resource: 'notification', action: 'update', before: old, row });
  }
  if (!same(prefsBefore, prefsAfter)) operations.push({ resource: 'prefs', action: 'update', before: prefsBefore, row: prefsAfter });
  const rank = {
    project: 1,
    task: 2,
    followUp: 2,
    subtask: 3,
    dependency: 3,
    comment: 3,
    reaction: 4,
    event: 3,
    view: 3,
    favourite: 4,
    notification: 4,
    prefs: 4,
  };
  return operations.sort(
    (a, b) => (a.action === 'delete' ? 20 - rank[a.resource] : rank[a.resource]) - (b.action === 'delete' ? 20 - rank[b.resource] : rank[b.resource]),
  );
}

/**
 * API/cache controller. It owns no DOM or navigation: callers install auth first and provide render callbacks.
 * The returned queueSnapshot is registered with store.save().
 */
export function createSync({
  request,
  workspacePath,
  storage = globalThis.localStorage,
  onData = () => {},
  onStatus = () => {},
  onConflict = () => {},
  setTimer = globalThis.setInterval?.bind(globalThis),
  clearTimer = globalThis.clearInterval?.bind(globalThis),
  events = globalThis,
} = {}) {
  if (typeof request !== 'function' || typeof workspacePath !== 'function') throw new TypeError('createSync needs request and workspacePath functions.');
  let profile;
  let workspace;
  let key;
  let state;
  let directory = null;
  let sessions = [];
  let timer;
  let flushing = false;
  let stopped = false;
  const idMap = new Map();
  const resolve = id => idMap.get(String(id)) || state?.idMap?.[String(id)] || id;
  const remember = (local, remote) => {
    idMap.set(String(local), remote);
    state.idMap ||= {};
    state.idMap[String(local)] = remote;
  };

  const persist = () => {
    if (!state || !key) return;
    write(storage, key, {
      ...state,
      base: withoutRestricted(state.base),
      outbox: state.outbox.map(item => ({ ...item, snapshot: withoutRestricted(item.snapshot) })),
    });
  };

  const publish = () => {
    if (!state) return;
    onData(toLegacyData(state.base, profile, directory, sessions), profile.prefs);
  };

  async function loadRestricted() {
    const sessionsRequest = request('/api/v1/me/sessions').catch(error => {
      if (error?.status === 401) throw error;
      return { data: { items: [] } };
    });
    const [found, active] = await Promise.all([request(workspacePath(workspace.slug, '/directory')), sessionsRequest]);
    directory = found.data;
    sessions = active.data?.items || [];
  }

  async function bootstrap({ publishData = true } = {}) {
    const response = await request(workspacePath(workspace.slug, '/bootstrap'));
    state.base = response.data;
    state.changeSeq = response.data.changeSeq;
    await loadRestricted();
    persist();
    if (publishData) publish();
  }

  async function pull() {
    if (!state) return;
    let more = true;
    while (more) {
      const response = await request(`${workspacePath(workspace.slug, '/changes')}?since=${encodeURIComponent(String(state.changeSeq || 0))}`);
      state.base = applyChanges(state.base, response.data.items || []);
      state.changeSeq = response.data.nextSince;
      more = Boolean(response.data.hasMore);
    }
    // The feed is intentionally visibility-filtered and cannot emit a tombstone when a
    // caller loses access to a private resource. Re-bootstrap before publishing so every
    // render is based on a current authorization snapshot rather than stale cache rows.
    await bootstrap({ publishData: state.outbox.length === 0 });
  }

  async function call(operation) {
    const path = suffix => workspacePath(workspace.slug, suffix);
    const id = resolve(operation.row.id);
    const options = { idempotencyKey: operation.action === 'create' ? `gr8r-${operation.resource}-${operation.row.id}` : undefined };
    if (operation.resource === 'project') {
      if (operation.action === 'create') {
        const result = await request(path('/projects'), { ...options, method: 'POST', body: projectBody(operation.row, true) });
        remember(operation.row.id, result.data.id);
      } else if (operation.action === 'delete') await request(path(`/projects/${id}`), { method: 'DELETE', etag: versionOf(operation.before) });
      else {
        const body = changed(projectBody(operation.before, false), projectBody(operation.row, false), Object.keys(projectBody(operation.row, false)));
        if (Object.keys(body).length) await request(path(`/projects/${id}`), { method: 'PATCH', etag: versionOf(operation.before), body });
      }
      return;
    }
    if (operation.resource === 'task') {
      if (operation.action === 'create') {
        const result = await request(path('/tasks'), { ...options, method: 'POST', body: taskBody(operation.row, true, resolve) });
        remember(operation.row.id, result.data.id);
      } else if (operation.action === 'delete') await request(path(`/tasks/${id}`), { method: 'DELETE', etag: versionOf(operation.before) });
      else {
        const body = changed(
          taskBody(operation.before, false, resolve),
          taskBody(operation.row, false, resolve),
          Object.keys(taskBody(operation.row, false, resolve)),
        );
        if (Object.keys(body).length) await request(path(`/tasks/${id}`), { method: 'PATCH', etag: versionOf(operation.before), body });
      }
      return;
    }
    if (operation.resource === 'followUp') {
      const parentId = resolve(operation.row.followsUpId || operation.row.followUpOf?.task);
      const result = await request(path(`/tasks/${parentId}/follow-ups`), {
        ...options,
        method: 'POST',
        body: {
          title: operation.row.title,
          gate: operation.row.followsUpGate ?? operation.row.followUpOf?.gate ?? null,
          storeId: operation.row.followsUpStoreId ?? operation.row.followUpOf?.storeId ?? null,
          assigneeId: operation.row.assignee ?? operation.row.assigneeId ?? null,
          dueDate: operation.row.due ?? operation.row.dueDate ?? null,
          note: operation.row.desc ?? operation.row.description ?? null,
        },
      });
      remember(operation.row.id, result.data.id);
      return;
    }
    if (operation.resource === 'comment') {
      if (operation.action === 'create') {
        const result = await request(path(`/tasks/${resolve(operation.row.task)}/comments`), {
          ...options,
          method: 'POST',
          body: { body: operation.row.text, mentionIds: operation.row.mentionIds || [] },
        });
        remember(operation.row.id, result.data.id);
      } else if (operation.action === 'delete') await request(path(`/comments/${id}`), { method: 'DELETE', etag: versionOf(operation.before) });
      else if (operation.before.text !== operation.row.text)
        await request(path(`/comments/${id}`), { method: 'PATCH', etag: versionOf(operation.before), body: { body: operation.row.text } });
      return;
    }
    if (operation.resource === 'subtask') {
      const taskId = resolve(operation.task.id);
      if (operation.action === 'create') {
        const result = await request(path(`/tasks/${taskId}/subtasks`), {
          ...options,
          method: 'POST',
          body: { title: operation.row.title, position: operation.row.position ?? 0 },
        });
        remember(operation.row.id, result.data.id);
      } else if (operation.action === 'delete') {
        await request(path(`/subtasks/${id}`), { method: 'DELETE', etag: versionOf(operation.before) });
      } else {
        const body = changed(operation.before, operation.row, ['title', 'done', 'position']);
        if (Object.keys(body).length) await request(path(`/subtasks/${id}`), { method: 'PATCH', etag: versionOf(operation.before), body });
      }
      return;
    }
    if (operation.resource === 'dependency') {
      await request(path(`/tasks/${id}/dependencies/${resolve(operation.dependency)}`), {
        method: operation.action === 'create' ? 'PUT' : 'DELETE',
      });
      return;
    }
    if (operation.resource === 'reaction') {
      await request(path(`/comments/${id}/reactions/${encodeURIComponent(operation.emoji)}`), {
        method: operation.action === 'create' ? 'PUT' : 'DELETE',
      });
      return;
    }
    if (operation.resource === 'event') {
      const body = {
        projectId: resolve(operation.row.project || operation.row.projectId) || null,
        title: operation.row.title,
        date: operation.row.date,
        timeText: operation.row.time || operation.row.timeText || null,
      };
      if (operation.action === 'create') {
        const result = await request(path('/events'), { ...options, method: 'POST', body });
        remember(operation.row.id, result.data.id);
      } else if (operation.action === 'delete') await request(path(`/events/${id}`), { method: 'DELETE', etag: versionOf(operation.before) });
      else {
        const old = {
          projectId: resolve(operation.before.project || operation.before.projectId) || null,
          title: operation.before.title,
          date: operation.before.date,
          timeText: operation.before.time || operation.before.timeText || null,
        };
        const patch = changed(old, body, Object.keys(body));
        if (Object.keys(patch).length) await request(path(`/events/${id}`), { method: 'PATCH', etag: versionOf(operation.before), body: patch });
      }
      return;
    }
    if (operation.resource === 'view') {
      const config = { filters: operation.row.filters || [], sort: operation.row.sort, group: operation.row.group, columns: operation.row.columns };
      const body = {
        name: operation.row.name,
        type: operation.row.type || 'list',
        config,
        projectId: resolve(operation.row.project || operation.row.projectId) || null,
      };
      if (operation.action === 'create') {
        const result = await request(path('/views'), { ...options, method: 'POST', body });
        remember(operation.row.id, result.data.id);
      } else if (operation.action === 'delete') await request(path(`/views/${id}`), { method: 'DELETE', etag: versionOf(operation.before) });
      else {
        const old = {
          name: operation.before.name,
          type: operation.before.type || 'list',
          config: operation.before.config || {},
          projectId: operation.before.project || operation.before.projectId || null,
        };
        const patch = changed(old, body, ['name', 'type', 'config']);
        if (Object.keys(patch).length) await request(path(`/views/${id}`), { method: 'PATCH', etag: versionOf(operation.before), body: patch });
      }
      return;
    }
    if (operation.resource === 'favourite') {
      await request(`/api/v1/me/favourites/${operation.kind}/${id}`, { method: operation.action === 'create' ? 'PUT' : 'DELETE' });
      return;
    }
    if (operation.resource === 'notification') {
      await request(`/api/v1/me/notifications/${id}`, {
        method: 'PATCH',
        etag: versionOf(operation.before),
        body: { read: Boolean(operation.row.read), archived: Boolean(operation.row.archived) },
      });
      return;
    }
    if (operation.resource === 'prefs') {
      const result = await request('/api/v1/me', { method: 'PATCH', etag: profile.user.version, body: { prefs: operation.row } });
      profile = result.data;
    }
  }

  const operationKey = operation =>
    [operation.resource, operation.action, operation.row?.id, operation.kind, operation.dependency, operation.emoji]
      .filter(value => value !== undefined && value !== null)
      .map(String)
      .join(':');

  async function flush() {
    if (flushing || stopped || !state?.outbox.length) return;
    flushing = true;
    onStatus({ offline: false, syncing: true });
    try {
      while (state.outbox.length) {
        const pending = state.outbox[0];
        if (pending.revalidate) {
          await bootstrap({ publishData: false });
          pending.revalidate = false;
          persist();
        }
        const reconciled = reconcileSnapshotIds(pending.snapshot, state.idMap);
        if (reconciled !== pending.snapshot && !same(reconciled, pending.snapshot)) {
          pending.snapshot = reconciled;
          persist();
        }
        const before = toLegacyData(state.base, profile, null, sessions);
        const operations = buildMutations(before, pending.snapshot, profile.prefs, pending.prefs);
        const completed = new Set(pending.completed || []);
        const acceptedRows = new Set();
        const acceptedFollowUps = new Set(
          [...completed]
            .filter(value => value.startsWith('followUp:create:'))
            .map(value => resolve(value.slice('followUp:create:'.length)))
            .map(String),
        );
        const baselineComments = new Set(pending.baseline?.comments || []);
        for (const operation of operations) {
          const operationId = operationKey(operation);
          if (completed.has(operationId)) continue;
          const resolvedId = resolve(operation.row?.id);
          const generatedFollowUpComment =
            operation.resource === 'comment' &&
            ((operation.action === 'create' && acceptedFollowUps.has(String(resolve(operation.row.followUpTaskId)))) ||
              (operation.action === 'delete' && acceptedFollowUps.size > 0 && !baselineComments.has(String(operation.row.id))));
          if (generatedFollowUpComment) {
            // The atomic follow-up route owns its generated comment. A resumed
            // snapshot still contains the local placeholder while bootstrap has
            // the server comment, so neither is a standalone client mutation.
            completed.add(operationId);
            pending.completed = [...completed];
            persist();
            continue;
          }
          if (operation.action === 'delete' && acceptedRows.has(`${operation.resource}:${resolvedId}`)) {
            // An ambiguous create can be returned by the server's idempotency record
            // after this diff was planned. Its remote twin was classified as a delete
            // before the local id was known; never execute that stale delete.
            completed.add(operationId);
            pending.completed = [...completed];
            persist();
            continue;
          }
          const localId = operation.row?.id;
          await call(operation);
          const remoteId = localId === null || localId === undefined ? undefined : state.idMap[String(localId)];
          if (operation.action === 'create' && remoteId) {
            const resource = operation.resource === 'followUp' ? 'task' : operation.resource;
            acceptedRows.add(`${resource}:${remoteId}`);
            if (operation.resource === 'followUp') acceptedFollowUps.add(String(remoteId));
          }
          completed.add(operationId);
          pending.completed = [...completed];
          persist();
        }
        const index = state.outbox.findIndex(item => item.id === pending.id);
        if (index >= 0) state.outbox.splice(index, 1);
        profile.prefs = pending.prefs;
        persist();
        await bootstrap({ publishData: state.outbox.length === 0 });
      }
      onStatus({ offline: false, syncing: false });
    } catch (error) {
      if (error?.status === 409) onConflict(error);
      else {
        if (state?.outbox[0] && (!error?.status || error.status >= 500)) state.outbox[0].revalidate = true;
        onStatus({ offline: true, syncing: false, error });
      }
      persist();
    } finally {
      flushing = false;
    }
  }

  function queueSnapshot({ data, prefs }) {
    if (!state) return;
    const pending = {
      id: `${Date.now()}-${Math.random()}`,
      snapshot: withoutRestricted(data),
      prefs: json(prefs),
      completed: [],
      baseline: { comments: (state.base.comments || []).map(comment => String(comment.id)) },
    };
    state.outbox = flushing && state.outbox.length ? [state.outbox[0], pending] : [pending];
    persist();
    queueMicrotask(() => void flush());
  }

  async function start(preferredWorkspace) {
    stopped = false;
    try {
      profile = (await request('/api/v1/me')).data;
    } catch (error) {
      if (error?.status === 401) clearCaches(storage);
      throw error;
    }
    const pointer = parse(storage, CACHE_POINTER_KEY);
    if (pointer && pointer.userId !== profile.user.id) clearCaches(storage);
    workspace =
      profile.workspaces.find(item => item.slug === preferredWorkspace || item.id === preferredWorkspace) ||
      profile.workspaces.find(item => item.id === pointer?.workspaceId) ||
      profile.workspaces[0];
    if (!workspace) throw new Error('Your account does not belong to a workspace. Ask an administrator to invite you.');
    key = cacheKey(profile, workspace);
    state = parse(storage, key);
    if (!state || state.userId !== profile.user.id || state.workspaceId !== workspace.id) {
      state = { userId: profile.user.id, workspaceId: workspace.id, workspaceSlug: workspace.slug, changeSeq: 0, base: null, outbox: [], idMap: {} };
    }
    state.outbox ||= [];
    state.idMap ||= {};
    try {
      // Cached rows are never rendered until the server has revalidated both identity and
      // current resource visibility. Offline or unauthorized boots therefore stay empty.
      await bootstrap();
      write(storage, CACHE_POINTER_KEY, { key, userId: profile.user.id, workspaceId: workspace.id, workspaceSlug: workspace.slug });
    } catch (error) {
      if (error?.status === 401) clearCaches(storage);
      throw error;
    }
    await flush();
    const refresh = () =>
      void pull()
        .then(flush)
        .catch(error => onStatus({ offline: true, syncing: false, error }));
    timer = setTimer?.(refresh, POLL_MS);
    events?.addEventListener?.('online', refresh);
    events?.addEventListener?.('focus', refresh);
    return { profile, workspace, queueSnapshot, pull, flush };
  }

  function stop() {
    stopped = true;
    if (timer !== undefined) clearTimer?.(timer);
  }

  return { start, stop, pull, flush, queueSnapshot };
}

/** Stable public boot contract used by the auth-owned main entrypoint. */
export async function startSync(options) {
  const controller = createSync(options);
  const session = await controller.start(options.preferredWorkspace);
  return { ...session, stop: controller.stop };
}
