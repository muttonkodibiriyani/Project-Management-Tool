import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Static } from 'typebox';
import { editsLine, isAdmin, isManager, MANAGERS, type Actor } from '../../access/policy.js';
import { tx, type Db } from '../../db/tx.js';
import { workspaceOf } from '../context.js';
import { contains, decodeCursor, omit, ifMatch, isOffset, mergePatch, page, toApi, withEtag, type Json, type Row } from '../http.js';
import { notify } from '../notify.js';
import type { ApiOptions } from '../plugin.js';
import { ApiError, forbidden, invalid, notFound } from '../problem.js';
import { change, conflict, created, diff, insertRow, json, lockRow, record, remove, updateRow } from '../rows.js';
import { sanitize } from '../sanitize.js';
import { DateOnly, Id, Limit, Values, Ws, WsId } from '../schemas.js';
import { checkValues, loadFields, withoutNulls } from '../values.js';
import { addLineStores, readProject, VISIBLE } from './projects.js';

const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);
const Priority = Type.Enum(['urgent', 'high', 'medium', 'low', 'none']);

/** The writable Task fields (API doc section 4). `kind` is create-only. */
const FIELDS = {
  title: Type.String({ minLength: 1, maxLength: 500 }),
  description: Type.String({ maxLength: 100000 }),
  status: Type.String({ minLength: 1, maxLength: 60 }),
  priority: Priority,
  assigneeId: Nullable(Id),
  startDate: Nullable(DateOnly),
  dueDate: Nullable(DateOnly),
  labels: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), { maxItems: 50 }),
  estimate: Nullable(Type.String({ maxLength: 40 })),
  recur: Nullable(Type.Record(Type.String(), Type.Unknown())),
  sortOrder: Type.Number(),
  archived: Type.Boolean(),
  brandId: Nullable(Id),
  externalKey: Nullable(Type.String({ maxLength: 200 })),
  notes: Nullable(Type.String({ maxLength: 20000 })),
  values: Values,
};
const Patch = Type.Partial(Type.Object(FIELDS), { additionalProperties: false, minProperties: 1 });
type PatchBody = Static<typeof Patch>;
const COLUMNS: Record<string, string> = {
  title: 'title',
  description: 'description',
  status: 'status',
  priority: 'priority',
  assigneeId: 'assignee_id',
  startDate: 'start_date',
  dueDate: 'due_date',
  labels: 'labels',
  estimate: 'estimate',
  recur: 'recur',
  sortOrder: 'sort_order',
  archived: 'archived',
  brandId: 'brand_id',
  externalKey: 'external_key',
  notes: 'notes',
};
const CreateKind = Type.Enum(['task', 'line', 'visit', 'meeting', 'npd']);
const INCLUDES = ['stores', 'installs', 'brand', 'brandMarket'] as const;
type Include = (typeof INCLUDES)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-z0-9_]{1,60}$/;

/** Done = gr8r's 'done', or an option of the template's status list marked done. `t` the task, `p` its project. */
const doneSql = (t: string, p: string) =>
  `(${t}.status = 'done' or exists (select 1 from template tp join list_option o on o.list_id = tp.status_list_id where tp.id = ${p}.template_id and o.key = ${t}.status and o.is_done))`;

/** `$1` is the caller (for favourites). */
const TASK_SELECT = `
  select t.*, p.template_id as project_template, p.market_code as project_market,
         exists (select 1 from favourite f where f.user_id = $1 and f.entity_kind = 'task' and f.entity_id = t.id) as favourite,
         coalesce((select json_agg(json_build_object('id', s.id, 'version', s.version, 'title', s.title, 'done', s.done, 'position', s.position) order by s.position, s.id)
                     from subtask s where s.task_id = t.id and s.deleted_at is null), '[]') as subtasks,
         array(select d.depends_on_id from task_dependency d where d.task_id = t.id order by d.depends_on_id) as dependency_ids,
         array(select f.id from file f where f.task_id = t.id and f.deleted_at is null order by f.created_at, f.id) as attachment_ids,
         (select count(*)::int from comment c where c.task_id = t.id and c.deleted_at is null) as comment_count,
         (select json_build_object('total', coalesce(sum(n), 0), 'byGate', coalesce(json_object_agg(gate, n) filter (where gate is not null), '{}'))
            from (select fu.follows_up_gate || coalesce('@' || fu.follows_up_store_id, '') as gate, count(*) as n
                    from task fu join project fp on fp.id = fu.project_id
                   where fu.follows_up_id = t.id and fu.kind = 'follow_up' and fu.deleted_at is null and not ${doneSql('fu', 'fp')}
                   group by 1) open) as open_follow_ups
    from task t join project p on p.id = t.project_id and p.deleted_at is null`;

export const renderTask = (row: Row) => omit(toApi(row), 'projectTemplate', 'projectMarket');
const renderLineStore = (row: Row) => toApi(row);

/** Section 1's task-list filters and sort, as SQL over parameters numbered after readTasks' first three. */
class TaskQuery {
  readonly where: string[] = [];
  readonly params: unknown[] = [];
  constructor(private readonly me: string) {}

  param(value: unknown) {
    this.params.push(value);
    return `$${String(this.params.length + 3)}`;
  }

  private ids(field: string, list: string[]) {
    const out = list.map(value => (value === 'me' ? this.me : value));
    if (!out.every(value => UUID.test(value))) throw bad(field, 'takes ids (or me)');
    return out;
  }

  filter(field: string, list: string[]) {
    const p = (value: unknown) => this.param(value);
    const text: Record<string, string> = { status: 't.status', priority: 't.priority', kind: 't.kind', followsUpGate: 't.follows_up_gate' };
    const ids: Record<string, string> = {
      assigneeId: 't.assignee_id',
      createdBy: 't.created_by',
      brandId: 't.brand_id',
      followsUpId: 't.follows_up_id',
      followsUpStoreId: 't.follows_up_store_id',
    };
    const due: Record<string, string> = {
      overdue: `(t.due_date < current_date and not ${doneSql('t', 'p')})`,
      today: 't.due_date = current_date',
      week: 't.due_date between current_date and current_date + 7',
      none: 't.due_date is null',
    };
    const [head, second, third] = field.split('.');
    const length = field.split('.').length;
    const textColumn = text[field];
    const idColumn = ids[field];
    if (textColumn) this.where.push(`${textColumn} = any(${p(list)}::text[])`);
    else if (idColumn) this.where.push(`${idColumn} = any(${p(this.ids(field, list))}::uuid[])`);
    else if (field === 'labels') this.where.push(`t.labels && ${p(list)}::text[]`);
    else if (field === 'open') this.where.push(list.includes('true') ? `not ${doneSql('t', 'p')}` : doneSql('t', 'p'));
    else if (field === 'archived') return;
    else if (field === 'due') {
      if (!list.every(value => due[value])) throw bad(field, 'takes overdue, today, week or none');
      this.where.push(`(${list.map(value => due[value]).join(' or ')})`);
    } else if (head === 'values' && length === 2 && KEY.test(second ?? '')) this.where.push(`t.values ->> ${p(second)} = any(${p(list)}::text[])`);
    else if (head === 'brand' && length === 2 && KEY.test(second ?? '')) {
      this.where.push(`exists (select 1 from brand b where b.id = t.brand_id and b.values ->> ${p(second)} = any(${p(list)}::text[]))`);
    } else if (head === 'brandMarket' && length === 2 && KEY.test(second ?? '')) {
      this.where.push(
        `exists (select 1 from brand_market bm where bm.brand_id = t.brand_id and bm.market_code = p.market_code and bm.deleted_at is null and bm.values ->> ${p(second)} = any(${p(list)}::text[]))`,
      );
    } else if (head === 'stores' && length === 3 && UUID.test(second ?? '') && KEY.test(third ?? '')) {
      this.where.push(
        `exists (select 1 from line_store ls where ls.task_id = t.id and ls.store_id = ${p(second)} and ls.deleted_at is null and ls.values ->> ${p(third)} = any(${p(list)}::text[]))`,
      );
    } else throw bad(field, 'is not a filter field');
  }

  orderBy(sort: string | undefined) {
    const field = sort?.replace(/^-/, '') ?? 'key';
    const direction = sort?.startsWith('-') ? 'desc' : 'asc';
    const sorts: Record<string, string[]> = {
      key: [`split_part(t.key, '-', 1)`, `nullif(substring(t.key from '[0-9]+$'), '')::int`],
      title: ['lower(t.title)'],
      dueDate: ['t.due_date'],
      updatedAt: ['t.updated_at'],
      sortOrder: ['t.sort_order'],
      readiness: ['t.readiness'],
    };
    const valueKey = field.startsWith('values.') ? field.slice('values.'.length) : undefined;
    const expressions = sorts[field] ?? (valueKey !== undefined && KEY.test(valueKey) ? [`t.values ->> ${this.param(valueKey)}`] : undefined);
    if (!expressions)
      throw new ApiError(
        400,
        'bad_request',
        `sort=${sort ?? ''} is not a sort field. Use key, title, dueDate, updatedAt, sortOrder, readiness or values.<key>, with - in front for descending.`,
      );
    return [...expressions, 't.id'].map(expression => `${expression} ${direction} nulls last`).join(', ');
  }
}

const bad = (field: string, why: string) => new ApiError(400, 'bad_filter', `filter[${field}] ${why}. See the API doc, section 1, for the task filters.`);

function includes(include: string | undefined): Include[] {
  const list = include?.split(',').filter(Boolean) ?? [];
  const unknown = list.filter(value => !(INCLUDES as readonly string[]).includes(value));
  if (unknown.length > 0) throw new ApiError(400, 'bad_request', `include=${unknown.join(',')} is not available. Use any of ${INCLUDES.join(', ')}.`);
  return list as Include[];
}

/** Non-gate fields of a line follow section 2's line rule; tasks of other kinds are edited by any editor. */
const editsTask = (actor: Actor, task: Row) =>
  task.kind !== 'line' || editsLine(actor, { assigneeId: (task.assignee_id as string | null) ?? null, brandTeam: (task.values as Row).brand_team });

/** Tasks the caller may see (in projects they may see). `$1` user, `$2` admin, `$3` workspace; the caller's params from `$4`. */
export async function readTasks(db: Db, request: FastifyRequest, where: string, params: unknown[], tail = '', include: Include[] = []) {
  const workspace = workspaceOf(request);
  const { rows } = await db.query<Row>(`${TASK_SELECT} where t.workspace_id = $3 and t.deleted_at is null and ${VISIBLE} and ${where} ${tail}`, [
    workspace.actor.userId,
    isAdmin(workspace.actor),
    workspace.id,
    ...params,
  ]);
  if (rows.length > 0) await attach(db, rows, include);
  return rows;
}

export async function readTask(db: Db, request: FastifyRequest, id: string, include: Include[] = []) {
  const row = (await readTasks(db, request, 't.id = $4', [id], '', include))[0];
  if (!row) throw notFound('This task');
  return row;
}

/** `?include=`: related rows for the whole page, one query per kind. */
async function attach(db: Db, rows: Row[], include: Include[]) {
  const grouped = async (sql: string, params: unknown[], key: string) => {
    const map = new Map<unknown, Row[]>();
    for (const row of (await db.query<Row>(sql, params)).rows) map.set(row[key], [...(map.get(row[key]) ?? []), toApi(row)]);
    return map;
  };
  const taskIds = rows.map(row => row.id);
  if (include.includes('stores')) {
    const stores = await grouped('select * from line_store where task_id = any($1) and deleted_at is null order by store_id', [taskIds], 'task_id');
    for (const row of rows) row.line_stores = stores.get(row.id) ?? [];
  }
  if (include.includes('installs')) {
    const installs = await grouped('select * from install where task_id = any($1) and deleted_at is null order by store_id, id', [taskIds], 'task_id');
    for (const row of rows) row.installs = installs.get(row.id) ?? [];
  }
  if (include.includes('brand')) {
    const brands = await grouped('select * from brand where id = any($1) and deleted_at is null', [rows.map(row => row.brand_id)], 'id');
    for (const row of rows) row.brand = brands.get(row.brand_id)?.[0] ?? null;
  }
  if (include.includes('brandMarket')) {
    const markets = await grouped(
      `select bm.*, bm.brand_id || '/' || bm.market_code as pair from brand_market bm
        where bm.deleted_at is null and (bm.brand_id, bm.market_code) in (select * from unnest($1::uuid[], $2::text[]))`,
      [rows.map(row => row.brand_id), rows.map(row => row.project_market)],
      'pair',
    );
    for (const row of rows) {
      const market = markets.get(`${String(row.brand_id)}/${String(row.project_market)}`)?.[0];
      if (market) delete market.pair;
      row.brand_market = market ?? null;
    }
  }
}

export function tasks(plain: FastifyInstance, { pool }: ApiOptions, done: () => void) {
  const app = plain.withTypeProvider<TypeBoxTypeProvider>();

  /** Assignees must be members of the workspace and brands must be its brands, so nothing points outside it. */
  async function checkRefs(db: Db, workspaceId: string, refs: { assigneeId?: string | null; brandId?: string | null }) {
    const errors = [];
    if (refs.assigneeId) {
      const member = await db.query('select 1 from workspace_member where workspace_id = $1 and user_id = $2 and deleted_at is null', [
        workspaceId,
        refs.assigneeId,
      ]);
      if (!member.rowCount) errors.push({ path: 'assigneeId', code: 'unknown_ref', message: 'The assignee is not a member of this workspace.' });
    }
    if (refs.brandId) {
      const brand = await db.query('select 1 from brand where workspace_id = $1 and id = $2 and deleted_at is null', [workspaceId, refs.brandId]);
      if (!brand.rowCount) errors.push({ path: 'brandId', code: 'unknown_ref', message: 'The brand does not exist in this workspace.' });
    }
    if (errors.length > 0) throw invalid(errors);
  }

  /** Every line of a brand in a market has the brand × market row its answers live on. */
  async function ensureBrandMarket(client: pg.PoolClient, workspaceId: string, brandId: unknown, marketCode: unknown) {
    if (!brandId || !marketCode) return;
    await client.query('insert into brand_market (workspace_id, brand_id, market_code) values ($1, $2, $3) on conflict (brand_id, market_code) do nothing', [
      workspaceId,
      brandId,
      marketCode,
    ]);
  }

  const assignText = (task: Row) => `assigned you ${String(task.key)}: ${String(task.title)}`;

  /** One task PATCH inside the caller's transaction: the version, then the rights per field, then the values. */
  async function patchTask(client: pg.PoolClient, request: FastifyRequest, id: string, version: number, body: PatchBody) {
    const workspace = workspaceOf(request);
    const actor = workspace.actor;
    const visible = await readTask(client, request, id);
    const before = await lockRow(client, 'task', id, workspace.id, undefined);
    if (before.version !== version) throw conflict(await readTask(client, request, id), renderTask);
    const mayEdit = editsTask(actor, before);
    const denied = Object.keys(body).filter(
      field => field !== 'values' && field !== 'sortOrder' && (!mayEdit || (field === 'archived' && before.kind === 'line' && !isManager(actor))),
    );
    if (denied.length > 0) {
      throw new ApiError(403, 'field_forbidden', `You may not change ${denied.join(', ')} on ${String(before.key)}. Nothing was saved.`, {
        errors: denied.map(path => ({ path, code: 'forbidden', message: 'Not yours to edit.' })),
      });
    }
    if (before.kind === 'line' && body.brandId === null) throw invalid([{ path: 'brandId', code: 'required', message: 'A launch line needs a brand.' }]);
    await checkRefs(client, workspace.id, body);
    const set: Row = { updated_by: actor.userId };
    for (const [field, value] of Object.entries(body)) {
      const column = COLUMNS[field];
      if (column)
        set[column] = field === 'description' && typeof value === 'string' ? sanitize(value) : field === 'recur' && value !== null ? json(value) : value;
    }
    if (body.values) {
      checkValues(await loadFields(client, workspace.id, (visible.project_template as string | null) ?? null, 'line'), body.values, actor, mayEdit);
      set.values = json(mergePatch(before.values as Record<string, Json>, body.values as Record<string, Json>));
    }
    const after = await updateRow(client, 'task', id, set);
    if (body.brandId) await ensureBrandMarket(client, workspace.id, body.brandId, visible.project_market);
    const changes = diff(renderTask(before), renderTask(after), Object.keys(body));
    await record(client, request, {
      verb: 'updated',
      entityKind: 'task',
      entityId: id,
      entityVersion: Number(after.version),
      projectId: String(after.project_id),
      taskId: id,
      changes,
    });
    if (body.assigneeId && body.assigneeId !== before.assignee_id)
      await notify(client, request, [body.assigneeId], 'assign', assignText(after), { taskId: id });
  }

  interface NewTask {
    kind: string;
    title: string;
    fields?: Partial<PatchBody>;
    extra?: Row;
  }

  /** Inserts a task: next key of the project, last in order, and for lines their line × store and brand × market rows. Logs it. */
  async function insertTask(client: pg.PoolClient, request: FastifyRequest, project: Row, task: NewTask) {
    const workspace = workspaceOf(request);
    const projectId = String(project.id);
    const { values = {}, ...fields } = task.fields ?? {};
    await checkRefs(client, workspace.id, fields);
    if (Object.keys(values).length > 0)
      checkValues(await loadFields(client, workspace.id, (project.template_id as string | null) ?? null, 'line'), values, workspace.actor, true);
    const counter = await client.query<{ key: string }>(
      `update project set next_task_no = next_task_no + 1 where id = $1 returning key || '-' || lpad((next_task_no - 1)::text, 3, '0') as key`,
      [projectId],
    );
    const order = await client.query<{ next: number }>('select coalesce(max(sort_order), 0) + 1 as next from task where project_id = $1', [projectId]);
    const columns: Row = {};
    for (const [field, value] of Object.entries(fields)) {
      const column = COLUMNS[field];
      if (column)
        columns[column] = field === 'description' && typeof value === 'string' ? sanitize(value) : field === 'recur' && value !== null ? json(value) : value;
    }
    const row = await insertRow(client, 'task', {
      sort_order: order.rows[0]?.next ?? 1,
      ...columns,
      ...task.extra,
      workspace_id: workspace.id,
      project_id: projectId,
      kind: task.kind,
      title: task.title,
      key: counter.rows[0]?.key,
      values: withoutNulls(values),
      created_by: workspace.actor.userId,
      updated_by: workspace.actor.userId,
    });
    const id = String(row.id);
    if (task.kind === 'line') {
      const stores = await client.query<{ store_id: string }>('select store_id from launch_store where project_id = $1 and deleted_at is null', [projectId]);
      await addLineStores(
        client,
        workspace.id,
        projectId,
        stores.rows.map(store => store.store_id),
        id,
      );
      await ensureBrandMarket(client, workspace.id, row.brand_id, project.market_code);
    }
    await record(client, request, { verb: 'created', entityKind: 'task', entityId: id, entityVersion: 1, projectId, taskId: id });
    if (row.assignee_id && task.kind !== 'follow_up') await notify(client, request, [row.assignee_id as string], 'assign', assignText(row), { taskId: id });
    return row;
  }

  const taskLocation = (request: FastifyRequest, id: unknown) => `/api/v1/w/${workspaceOf(request).slug}/tasks/${String(id)}`;

  app.get(
    '/tasks',
    {
      config: { access: 'any' },
      schema: {
        params: Ws,
        querystring: Type.Object(
          {
            projectId: Type.Optional(Id),
            include: Type.Optional(Type.String({ maxLength: 200 })),
            q: Type.Optional(Type.String({ maxLength: 200 })),
            sort: Type.Optional(Type.String({ maxLength: 80 })),
            limit: Limit(200),
            cursor: Type.Optional(Type.String({ maxLength: 200 })),
          },
          { patternProperties: { '^filter\\[[A-Za-z0-9_.-]+\\]$': Type.String({ maxLength: 20000 }) }, additionalProperties: false },
        ),
      },
    },
    async request => {
      const { projectId, include, q, sort, limit, cursor } = request.query;
      const offset = decodeCursor(cursor, isOffset) ?? 0;
      const query = new TaskQuery(workspaceOf(request).actor.userId);
      if (projectId) query.where.push(`t.project_id = ${query.param(projectId)}`);
      if (q) {
        const like = query.param(contains(q));
        query.where.push(`(t.key ilike ${like} or t.title ilike ${like} or exists (select 1 from brand b where b.id = t.brand_id and b.name ilike ${like}))`);
      }
      let archived = false;
      for (const [name, raw] of Object.entries(request.query as Record<string, unknown>)) {
        const field = /^filter\[(.+)\]$/.exec(name)?.[1];
        if (!field) continue;
        const list = String(raw)
          .split(',')
          .filter(value => value !== '');
        if (list.length === 0) throw bad(field, 'needs at least one value');
        if (field === 'archived') archived = list.includes('true');
        query.filter(field, list);
      }
      query.where.push(`t.archived = ${query.param(archived)}`);
      const order = query.orderBy(sort);
      const rows = await readTasks(
        pool,
        request,
        query.where.join(' and '),
        query.params,
        `order by ${order} limit ${String(limit + 1)} offset ${String(offset)}`,
        includes(include),
      );
      return page(rows, limit, () => offset + limit, renderTask);
    },
  );

  app.get(
    '/tasks/:id',
    {
      config: { access: 'any' },
      schema: { params: WsId, querystring: Type.Object({ include: Type.Optional(Type.String({ maxLength: 200 })) }, { additionalProperties: false }) },
    },
    async (request, reply) => withEtag(reply, renderTask(await readTask(pool, request, request.params.id, includes(request.query.include)))),
  );

  app.post(
    '/tasks',
    {
      config: { access: 'editor' },
      schema: {
        params: Ws,
        body: Type.Object(
          { ...Type.Partial(Type.Object(FIELDS)).properties, projectId: Id, title: FIELDS.title, kind: Type.Optional(CreateKind) },
          { additionalProperties: false },
        ),
      },
    },
    (request, reply) =>
      created(pool, request, reply, async () => {
        const { projectId, kind = 'task', title, ...fields } = request.body;
        const project = await readProject(pool, request, projectId);
        if (kind === 'line') {
          if (!isManager(workspaceOf(request).actor)) throw forbidden('Only Launch managers and admins create launch lines.');
          if (project.kind !== 'launch') throw invalid([{ path: 'kind', code: 'out_of_range', message: 'Launch lines belong to launch projects.' }]);
          if (!fields.brandId) throw invalid([{ path: 'brandId', code: 'required', message: 'A launch line needs a brand.' }]);
        }
        const row = await tx(pool, client => insertTask(client, request, project, { kind, title, fields }));
        return { body: renderTask(await readTask(pool, request, String(row.id))), location: taskLocation(request, row.id) };
      }),
  );

  app.patch('/tasks/:id', { config: { access: 'editor' }, schema: { params: WsId, body: Patch } }, async (request, reply) => {
    const version = ifMatch(request);
    await tx(pool, client => patchTask(client, request, request.params.id, version, request.body));
    return withEtag(reply, renderTask(await readTask(pool, request, request.params.id)));
  });

  app.delete('/tasks/:id', { config: { access: 'editor' }, schema: { params: WsId } }, async (request, reply) => {
    await readTask(pool, request, request.params.id);
    await remove(pool, request, {
      table: 'task',
      kind: 'task',
      id: request.params.id,
      render: renderTask,
      context: row => ({ projectId: String(row.project_id), taskId: String(row.id) }),
      check: row => {
        if (row.kind === 'line' && !isManager(workspaceOf(request).actor)) throw forbidden('Only Launch managers and admins delete launch lines.');
      },
    });
    return reply.code(204).send();
  });

  app.post(
    '/tasks/bulk',
    {
      config: { access: 'editor' },
      schema: {
        params: Ws,
        body: Type.Object(
          {
            atomic: Type.Optional(Type.Boolean()),
            items: Type.Array(Type.Object({ id: Id, version: Type.Integer({ minimum: 1 }), patch: Patch }, { additionalProperties: false }), {
              minItems: 1,
              maxItems: 500,
            }),
          },
          { additionalProperties: false },
        ),
      },
    },
    async request => {
      const { atomic = false, items } = request.body;
      if (atomic) {
        await tx(pool, async client => {
          for (const item of items) await patchTask(client, request, item.id, item.version, item.patch);
        });
        const rows = await readTasks(pool, request, 't.id = any($4)', [items.map(item => item.id)]);
        return { results: items.map(item => ({ id: item.id, status: 200, task: renderTask(rows.find(row => row.id === item.id) ?? {}) })) };
      }
      const results = [];
      for (const item of items) {
        try {
          await tx(pool, client => patchTask(client, request, item.id, item.version, item.patch));
          results.push({ id: item.id, status: 200, task: renderTask(await readTask(pool, request, item.id)) });
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          results.push({ id: item.id, status: error.status, error: error.body(request.id) });
        }
      }
      return { results };
    },
  );

  app.post(
    '/tasks/:id/duplicate',
    {
      config: { access: 'editor' },
      schema: { params: WsId, body: Type.Object({ double: Type.Optional(Type.Boolean()), values: Type.Optional(Values) }, { additionalProperties: false }) },
    },
    (request, reply) =>
      created(pool, request, reply, async () => {
        const { double = false, values = {} } = request.body;
        const source = await readTask(pool, request, request.params.id);
        const project = await readProject(pool, request, String(source.project_id));
        if (double) {
          if (!isManager(workspaceOf(request).actor)) throw forbidden('Only Launch managers and admins place a line twice (DOUBLE).');
          if (source.kind !== 'line') throw invalid([{ path: 'double', code: 'out_of_range', message: 'Only launch lines can be placed twice.' }]);
        } else if (source.kind !== 'task') {
          throw invalid([
            { path: 'double', code: 'out_of_range', message: 'Plain duplicates are for tasks; a launch line is placed again with double: true.' },
          ]);
        }
        const copied = {
          description: source.description as string,
          priority: source.priority as PatchBody['priority'],
          assigneeId: source.assignee_id as string | null,
          startDate: source.start_date as string | null,
          dueDate: source.due_date as string | null,
          labels: source.labels as string[],
          estimate: source.estimate as string | null,
          recur: source.recur as Record<string, unknown> | null,
          brandId: source.brand_id as string | null,
          externalKey: source.external_key as string | null,
          notes: source.notes as string | null,
          values: { ...(source.values as Row), ...values },
        };
        const row = await tx(pool, async client => {
          const copy = await insertTask(client, request, project, {
            kind: String(source.kind),
            title: double ? String(source.title) : `${String(source.title)} (copy)`,
            fields: copied,
            extra: { status: source.status, double_of_id: double ? (source.double_of_id ?? source.id) : null },
          });
          if (!double) {
            await client.query(
              `insert into subtask (task_id, title, done, position) select $1, title, done, position from subtask where task_id = $2 and deleted_at is null`,
              [copy.id, source.id],
            );
          }
          return copy;
        });
        return { body: renderTask(await readTask(pool, request, String(row.id))), location: taskLocation(request, row.id) };
      }),
  );

  // ---------- follow-ups ----------
  const FollowUp = {
    title: FIELDS.title,
    gate: Type.Optional(Nullable(Type.String({ pattern: '^[a-z0-9_]{1,60}$' }))),
    storeId: Type.Optional(Nullable(Id)),
    assigneeId: Type.Optional(Nullable(Id)),
    dueDate: Type.Optional(Nullable(DateOnly)),
    note: Type.Optional(Nullable(Type.String({ maxLength: 20000 }))),
  };
  type FollowUpBody = Static<ReturnType<typeof Type.Object<typeof FollowUp>>>;

  /** Raises follow-ups on lines of one project: checks the gate and store, creates the tasks and a comment on each line. */
  async function raiseFollowUps(client: pg.PoolClient, request: FastifyRequest, lines: Row[], body: FollowUpBody) {
    const workspace = workspaceOf(request);
    const projectIds = new Set(lines.map(line => line.project_id));
    const created: Row[] = [];
    for (const projectId of projectIds) {
      const project = await readProject(client, request, String(projectId));
      if (body.gate) {
        const templateId = (project.template_id as string | null) ?? null;
        const lineField = (await loadFields(client, workspace.id, templateId, 'line')).get(body.gate);
        const storeField = (await loadFields(client, workspace.id, templateId, 'line_store')).get(body.gate);
        if (!lineField && !storeField)
          throw invalid([{ path: 'gate', code: 'unknown_field', message: `${body.gate} is not a field of this launch's template.` }]);
        if (storeField && !body.storeId)
          throw invalid([{ path: 'storeId', code: 'required', message: `${storeField.label} is answered per store, so say which store to chase.` }]);
      }
      for (const line of lines.filter(row => row.project_id === projectId)) {
        if (body.storeId) {
          const store = await client.query('select 1 from line_store where task_id = $1 and store_id = $2 and deleted_at is null', [line.id, body.storeId]);
          if (!store.rowCount) throw invalid([{ path: 'storeId', code: 'unknown_ref', message: `${String(line.key)} has no row for that store.` }]);
        }
        const task = await insertTask(client, request, project, {
          kind: 'follow_up',
          title: body.title,
          fields: { assigneeId: body.assigneeId ?? null, dueDate: body.dueDate ?? null, notes: body.note ?? null },
          extra: { follows_up_id: line.id, follows_up_gate: body.gate ?? null, follows_up_store_id: body.storeId ?? null },
        });
        const comment = await insertRow(client, 'comment', {
          workspace_id: workspace.id,
          task_id: line.id,
          author_id: workspace.actor.userId,
          body: sanitize(`<p>Follow-up ${String(task.key)}: ${escapeHtml(body.title)}${body.dueDate ? ` (due ${body.dueDate})` : ''}</p>`),
        });
        await record(client, request, {
          verb: 'commented',
          entityKind: 'comment',
          entityId: String(comment.id),
          entityVersion: 1,
          projectId: String(projectId),
          taskId: String(line.id),
        });
        created.push(task);
      }
    }
    return created;
  }

  const due = (date: string | null | undefined) => (date ? ` by ${date}` : '');

  app.post(
    '/tasks/:id/follow-ups',
    { config: { access: 'editor' }, schema: { params: WsId, body: Type.Object(FollowUp, { additionalProperties: false }) } },
    (request, reply) =>
      created(pool, request, reply, async () => {
        const line = await readTask(pool, request, request.params.id);
        const body = request.body;
        const [task] = await tx(pool, async client => {
          const raised = await raiseFollowUps(client, request, [line], body);
          await notify(client, request, [body.assigneeId], 'follow_up', `asked you to follow up ${String(line.key)}${due(body.dueDate)}`, {
            taskId: String(raised[0]?.id),
          });
          return raised;
        });
        return { body: renderTask(await readTask(pool, request, String(task?.id))), location: taskLocation(request, task?.id) };
      }),
  );

  app.post(
    '/follow-ups',
    {
      config: { access: 'editor' },
      schema: {
        params: Ws,
        body: Type.Object({ ...FollowUp, lineIds: Type.Array(Id, { minItems: 1, maxItems: 500, uniqueItems: true }) }, { additionalProperties: false }),
      },
    },
    async (request, reply) => {
      const { lineIds, ...body } = request.body;
      const lines = await readTasks(pool, request, 't.id = any($4)', [lineIds]);
      if (lines.length !== lineIds.length) throw notFound('One of these lines');
      const raised = await tx(pool, async client => {
        const tasks = await raiseFollowUps(client, request, lines, body);
        await notify(client, request, [body.assigneeId], 'follow_up', `asked you to follow up ${String(tasks.length)} lines${due(body.dueDate)}`, {
          taskId: String(tasks[0]?.id),
        });
        return tasks;
      });
      const rows = await readTasks(pool, request, 't.id = any($4)', [raised.map(task => task.id)], 'order by t.key');
      return reply.code(201).send({ items: rows.map(renderTask) });
    },
  );

  // ---------- line × store ----------
  app.get('/tasks/:id/stores', { config: { access: 'any' }, schema: { params: WsId } }, async request => {
    await readTask(pool, request, request.params.id);
    const { rows } = await pool.query<Row>('select * from line_store where task_id = $1 and deleted_at is null order by store_id', [request.params.id]);
    return { items: rows.map(renderLineStore), nextCursor: null };
  });

  app.post(
    '/tasks/:id/stores',
    {
      config: { access: MANAGERS },
      schema: { params: WsId, body: Type.Object({ storeId: Id, values: Type.Optional(Values) }, { additionalProperties: false }) },
    },
    (request, reply) =>
      created(pool, request, reply, async () => {
        const workspace = workspaceOf(request);
        const line = await readTask(pool, request, request.params.id);
        if (line.kind !== 'line') throw invalid([{ path: 'storeId', code: 'out_of_range', message: 'Only launch lines have rows per store.' }]);
        const { storeId, values = {} } = request.body;
        const store = await pool.query('select 1 from store where workspace_id = $1 and id = $2 and deleted_at is null', [workspace.id, storeId]);
        if (!store.rowCount) throw invalid([{ path: 'storeId', code: 'unknown_ref', message: 'The store does not exist in this workspace.' }]);
        checkValues(await loadFields(pool, workspace.id, (line.project_template as string | null) ?? null, 'line_store'), values, workspace.actor, true);
        const row = await tx(pool, async client => {
          const inserted = await insertRow(client, 'line_store', {
            workspace_id: workspace.id,
            task_id: line.id,
            store_id: storeId,
            values: withoutNulls(values),
            updated_by: workspace.actor.userId,
          });
          await record(client, request, {
            verb: 'created',
            entityKind: 'line_store',
            entityId: String(inserted.id),
            entityVersion: 1,
            projectId: String(line.project_id),
            taskId: String(line.id),
          });
          return inserted;
        });
        return { body: renderLineStore(row), location: `${taskLocation(request, line.id)}/stores/${storeId}` };
      }),
  );

  app.patch(
    '/tasks/:id/stores/:storeId',
    {
      config: { access: 'editor' },
      schema: { params: Type.Object({ ws: Type.String(), id: Id, storeId: Id }), body: Type.Object({ values: Values }, { additionalProperties: false }) },
    },
    async (request, reply) => {
      const workspace = workspaceOf(request);
      const line = await readTask(pool, request, request.params.id);
      const found = await pool.query<{ id: string }>('select id from line_store where task_id = $1 and store_id = $2 and deleted_at is null', [
        line.id,
        request.params.storeId,
      ]);
      const lineStoreId = found.rows[0]?.id;
      if (!lineStoreId) throw notFound('This line has no row for that store; it');
      const fields = await loadFields(pool, workspace.id, (line.project_template as string | null) ?? null, 'line_store');
      return withEtag(
        reply,
        await change(pool, request, {
          table: 'line_store',
          kind: 'line_store',
          id: lineStoreId,
          render: renderLineStore,
          context: () => ({ projectId: String(line.project_id), taskId: String(line.id) }),
          set: before => {
            checkValues(fields, request.body.values, workspace.actor, editsTask(workspace.actor, line));
            return {
              values: json(mergePatch(before.values as Record<string, Json>, request.body.values as Record<string, Json>)),
              updated_by: workspace.actor.userId,
            };
          },
        }),
      );
    },
  );

  // ---------- subtasks ----------
  const renderSubtask = (row: Row) => toApi(row);
  const subtaskContext = (task: Row) => () => ({ taskId: String(task.id), projectId: String(task.project_id) });
  /** The subtask's task, which the caller must be able to see. */
  async function subtaskTask(request: FastifyRequest, id: string) {
    const { rows } = await pool.query<{ task_id: string }>('select task_id from subtask where id = $1 and deleted_at is null', [id]);
    if (!rows[0]) throw notFound('This subtask');
    return readTask(pool, request, rows[0].task_id);
  }

  app.post(
    '/tasks/:id/subtasks',
    {
      config: { access: 'editor' },
      schema: {
        params: WsId,
        body: Type.Object(
          { title: Type.String({ minLength: 1, maxLength: 500 }), position: Type.Optional(Type.Integer({ minimum: 0 })) },
          { additionalProperties: false },
        ),
      },
    },
    (request, reply) =>
      created(pool, request, reply, async () => {
        const task = await readTask(pool, request, request.params.id);
        const row = await tx(pool, async client => {
          const subtask = await insertRow(client, 'subtask', {
            task_id: task.id,
            title: request.body.title,
            position: request.body.position ?? (task.subtasks as unknown[]).length,
          });
          await record(client, request, {
            verb: 'created',
            entityKind: 'subtask',
            entityId: String(subtask.id),
            entityVersion: 1,
            projectId: String(task.project_id),
            taskId: String(task.id),
          });
          return subtask;
        });
        return { body: renderSubtask(row), location: `/api/v1/w/${workspaceOf(request).slug}/subtasks/${String(row.id)}` };
      }),
  );

  app.patch(
    '/subtasks/:id',
    {
      config: { access: 'editor' },
      schema: {
        params: WsId,
        body: Type.Partial(
          Type.Object({ title: Type.String({ minLength: 1, maxLength: 500 }), done: Type.Boolean(), position: Type.Integer({ minimum: 0 }) }),
          {
            additionalProperties: false,
            minProperties: 1,
          },
        ),
      },
    },
    async (request, reply) => {
      const context = subtaskContext(await subtaskTask(request, request.params.id));
      return withEtag(
        reply,
        await change(pool, request, {
          table: 'subtask',
          kind: 'subtask',
          id: request.params.id,
          render: renderSubtask,
          context,
          set: () => ({ ...request.body }),
        }),
      );
    },
  );

  app.delete('/subtasks/:id', { config: { access: 'editor' }, schema: { params: WsId } }, async (request, reply) => {
    const context = subtaskContext(await subtaskTask(request, request.params.id));
    await remove(pool, request, { table: 'subtask', kind: 'subtask', id: request.params.id, render: renderSubtask, context });
    return reply.code(204).send();
  });

  // ---------- dependencies ----------
  const DependencyParams = Type.Object({ ws: Type.String(), id: Id, otherId: Id });

  /** Adds or drops "id waits for otherId"; the task's version moves on so caches see the new dependencyIds. */
  async function setDependency(request: FastifyRequest<{ Params: Static<typeof DependencyParams> }>, add: boolean) {
    const { id, otherId } = request.params;
    const workspace = workspaceOf(request);
    const before = renderTask(await readTask(pool, request, id));
    await readTask(pool, request, otherId);
    await tx(pool, async client => {
      await lockRow(client, 'task', id, workspace.id, undefined);
      if (add) {
        if (id === otherId) throw invalid([{ path: 'otherId', code: 'out_of_range', message: 'A task cannot wait for itself.' }]);
        const cycle = await client.query(
          `with recursive waits(task_id) as (select depends_on_id from task_dependency where task_id = $1
                                             union select d.depends_on_id from task_dependency d join waits w on d.task_id = w.task_id)
           select 1 from waits where task_id = $2 limit 1`,
          [otherId, id],
        );
        if (cycle.rowCount)
          throw invalid([{ path: 'otherId', code: 'out_of_range', message: 'That task already waits for this one, so this would make a loop.' }]);
        await client.query('insert into task_dependency (task_id, depends_on_id) values ($1, $2) on conflict do nothing', [id, otherId]);
      } else {
        await client.query('delete from task_dependency where task_id = $1 and depends_on_id = $2', [id, otherId]);
      }
      const after = await updateRow(client, 'task', id, { updated_by: workspace.actor.userId });
      const now = renderTask(await readTask(client, request, id));
      await record(client, request, {
        verb: 'updated',
        entityKind: 'task',
        entityId: id,
        entityVersion: Number(after.version),
        projectId: String(after.project_id),
        taskId: id,
        changes: diff(before, now, ['dependencyIds']),
      });
    });
  }

  app.put('/tasks/:id/dependencies/:otherId', { config: { access: 'editor' }, schema: { params: DependencyParams } }, async (request, reply) => {
    await setDependency(request, true);
    return reply.code(204).send();
  });

  app.delete('/tasks/:id/dependencies/:otherId', { config: { access: 'editor' }, schema: { params: DependencyParams } }, async (request, reply) => {
    await setDependency(request, false);
    return reply.code(204).send();
  });
  done();
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, c => `&#${String(c.charCodeAt(0))};`);
