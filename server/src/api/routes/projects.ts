import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { isAdmin, isManager, MANAGERS } from '../../access/policy.js';
import { tx, type Db } from '../../db/tx.js';
import { workspaceOf } from '../context.js';
import { decodeCursor, ifMatch, isKeyset, page, toApi, withEtag, type Row } from '../http.js';
import type { ApiOptions } from '../plugin.js';
import { ApiError, forbidden, invalid, notFound } from '../problem.js';
import { change, columnsOf, created, diff, insertRow, lockRow, record, remove, updateRow } from '../rows.js';
import { DateOnly, Id, Limit, Ws, WsId } from '../schemas.js';

const Kind = Type.Enum(['launch', 'npd', 'visit', 'general']);
const Status = Type.Enum(['planning', 'active', 'risk', 'hold', 'complete']);
const Nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);
const StoreSlots = Type.Array(Type.Object({ storeId: Id, slot: Type.Integer({ minimum: 1, maximum: 20 }) }, { additionalProperties: false }), { maxItems: 20 });

const EDITABLE = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 20000 }),
  launchCode: Nullable(Type.String({ maxLength: 40 })),
  marketCode: Nullable(Type.String({ pattern: '^[A-Z]{3}$' })),
  icon: Type.String({ maxLength: 40 }),
  colour: Type.String({ maxLength: 40 }),
  status: Status,
  teamId: Nullable(Id),
  leadId: Nullable(Id),
  startDate: Nullable(DateOnly),
  dueDate: Nullable(DateOnly),
  private: Type.Boolean(),
  archived: Type.Boolean(),
};

/** A project the caller may see: private ones only for their members and Workspace.Admin. `$1` user, `$2` admin. */
export const VISIBLE = `(not p.private or $2::boolean or exists (select 1 from project_member pm where pm.project_id = p.id and pm.user_id = $1))`;

const PROJECT_SELECT = `
  select p.*,
         coalesce((select json_agg(json_build_object('storeId', ls.store_id, 'slot', ls.slot) order by ls.slot)
                     from launch_store ls where ls.project_id = p.id and ls.deleted_at is null), '[]') as stores,
         array(select r.reference_id from launch_reference r where r.project_id = p.id order by r.reference_id) as reference_ids,
         array(select pm.user_id from project_member pm where pm.project_id = p.id order by pm.user_id) as member_ids,
         coalesce((select json_agg(json_build_object('id', m.id, 'version', m.version, 'name', m.name, 'date', m.date, 'storeId', m.store_id) order by m.date, m.id)
                     from milestone m where m.project_id = p.id and m.deleted_at is null), '[]') as milestones,
         exists (select 1 from favourite f where f.user_id = $1 and f.entity_kind = 'project' and f.entity_id = p.id) as favourite,
         coalesce((select case when p.kind = 'launch' then avg(coalesce(t.readiness, 0)) else avg(case when t.status = 'done' then 1 else 0 end) end
                     from task t where t.project_id = p.id and t.deleted_at is null and not t.archived
                      and (p.kind <> 'launch' or t.kind = 'line')), 0) as progress
    from project p`;

export const renderProject = (row: Row) => toApi(row);

/** Projects the caller may see, by id; 404 for the rest, so private projects are not discoverable. */
export async function readProjects(db: Db, request: FastifyRequest, where: string, params: unknown[]): Promise<Row[]> {
  const workspace = workspaceOf(request);
  const { rows } = await db.query<Row>(`${PROJECT_SELECT} where p.workspace_id = $3 and p.deleted_at is null and ${VISIBLE} and ${where}`, [
    workspace.actor.userId,
    isAdmin(workspace.actor),
    workspace.id,
    ...params,
  ]);
  return rows;
}

export async function readProject(db: Db, request: FastifyRequest, id: string): Promise<Row> {
  const row = (await readProjects(db, request, 'p.id = $4', [id]))[0];
  if (!row) throw notFound('This project');
  return row;
}

/** Launches are run by LM and ADM; other projects by any editor (the route already requires one). */
function mayManage(request: FastifyRequest, kind: unknown) {
  if (kind === 'launch' && !isManager(workspaceOf(request).actor)) throw forbidden('Only Launch managers and admins change launches.');
}

/** Gives every live line of the project a line × store row for each of these stores (revives soft-deleted ones). */
export async function addLineStores(client: pg.PoolClient, workspaceId: string, projectId: string, storeIds: string[], taskId: string | null = null) {
  if (storeIds.length === 0) return;
  await client.query(
    `insert into line_store (workspace_id, task_id, store_id)
     select $1, t.id, s from task t cross join unnest($3::uuid[]) s
      where t.project_id = $2 and t.kind = 'line' and t.deleted_at is null and ($4::uuid is null or t.id = $4)
     on conflict (task_id, store_id) do update set deleted_at = null, version = line_store.version + 1 where line_store.deleted_at is not null`,
    [workspaceId, projectId, storeIds, taskId],
  );
}

export function projects(plain: FastifyInstance, { pool }: ApiOptions, done: () => void) {
  const app = plain.withTypeProvider<TypeBoxTypeProvider>();

  async function setStores(client: pg.PoolClient, request: FastifyRequest, projectId: string, stores: { storeId: string; slot: number }[], force: boolean) {
    const workspaceId = workspaceOf(request).id;
    const known = await client.query<{ id: string }>('select id from store where workspace_id = $1 and id = any($2) and deleted_at is null', [
      workspaceId,
      stores.map(s => s.storeId),
    ]);
    const missing = stores.filter(s => !known.rows.some(row => row.id === s.storeId));
    if (missing.length > 0) throw invalid(missing.map(s => ({ path: 'stores', code: 'unknown_ref', message: `Store ${s.storeId} does not exist.` })));
    const current = await client.query<{ store_id: string }>('select store_id from launch_store where project_id = $1 and deleted_at is null', [projectId]);
    const removed = current.rows.map(row => row.store_id).filter(id => !stores.some(s => s.storeId === id));
    if (removed.length > 0) {
      const used = await client.query(
        `select 1 from line_store where store_id = any($1) and values <> '{}' and deleted_at is null and task_id in (select id from task where project_id = $2) limit 1`,
        [removed, projectId],
      );
      if (used.rowCount && !force) {
        throw new ApiError(
          422,
          'validation_failed',
          'Lines hold answers for a store you are removing. Send ?force=true to remove it anyway; the answers are kept in the history.',
          {
            errors: [{ path: 'stores', code: 'required', message: 'The store has answers.' }],
          },
        );
      }
      await client.query(
        'update line_store set deleted_at = now() where store_id = any($1) and deleted_at is null and task_id in (select id from task where project_id = $2)',
        [removed, projectId],
      );
    }
    // The launch's stores are part of the project (its version and /changes carry them), so the layout is simply rewritten.
    await client.query('delete from launch_store where project_id = $1', [projectId]);
    await client.query('insert into launch_store (project_id, store_id, slot) select $1, unnest($2::uuid[]), unnest($3::int[])', [
      projectId,
      stores.map(s => s.storeId),
      stores.map(s => s.slot),
    ]);
    await addLineStores(
      client,
      workspaceId,
      projectId,
      stores.map(s => s.storeId),
    );
  }

  app.get(
    '/projects',
    {
      config: { access: 'any' },
      schema: {
        params: Ws,
        querystring: Type.Object({
          archived: Type.Optional(Type.Boolean()),
          kind: Type.Optional(Kind),
          limit: Limit(100),
          cursor: Type.Optional(Type.String()),
        }),
      },
    },
    async request => {
      const { archived = false, kind, limit, cursor } = request.query;
      const after = decodeCursor(cursor, isKeyset);
      const rows = await readProjects(
        pool,
        request,
        `p.archived = $4 and ($5::text is null or p.kind = $5) and ($6::text is null or (p.name, p.id) > ($6, $7::uuid)) order by p.name, p.id limit $8`,
        [archived, kind ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
      );
      return page(rows, limit, last => [String(last.name), String(last.id)], renderProject);
    },
  );

  app.get('/projects/:id', { config: { access: 'any' }, schema: { params: WsId } }, async (request, reply) =>
    withEtag(reply, renderProject(await readProject(pool, request, request.params.id))),
  );

  app.post(
    '/projects',
    {
      config: { access: 'editor' },
      schema: {
        params: Ws,
        body: Type.Object(
          {
            ...Type.Partial(Type.Object(EDITABLE)).properties,
            name: EDITABLE.name,
            key: Type.String({ pattern: '^[A-Z]{2,6}$' }),
            kind: Kind,
            templateId: Type.Optional(Nullable(Id)),
            stores: Type.Optional(StoreSlots),
            referenceIds: Type.Optional(Type.Array(Id, { maxItems: 50 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    (request, reply) =>
      created(pool, request, reply, async () => {
        const { stores = [], referenceIds = [], ...fields } = request.body;
        mayManage(request, fields.kind);
        if (fields.kind === 'launch') {
          const missing = (['templateId', 'marketCode'] as const).filter(field => !fields[field]);
          if (missing.length > 0) throw invalid(missing.map(field => ({ path: field, code: 'required', message: `A launch needs ${field}.` })));
        }
        const workspace = workspaceOf(request);
        const id = await tx(pool, async client => {
          const row = await insertRow(client, 'project', { workspace_id: workspace.id, created_by: workspace.actor.userId, ...columnsOf(fields) });
          const projectId = String(row.id);
          await client.query('insert into project_member (project_id, user_id) values ($1, $2)', [projectId, workspace.actor.userId]);
          await setStores(client, request, projectId, stores, false);
          for (const referenceId of referenceIds)
            await client.query('insert into launch_reference (project_id, reference_id) values ($1, $2)', [projectId, referenceId]);
          await record(client, request, { verb: 'created', entityKind: 'project', entityId: projectId, entityVersion: 1, projectId });
          return projectId;
        });
        return { body: renderProject(await readProject(pool, request, id)), location: `/api/v1/w/${workspace.slug}/projects/${id}` };
      }),
  );

  app.patch(
    '/projects/:id',
    { config: { access: 'editor' }, schema: { params: WsId, body: Type.Partial(Type.Object(EDITABLE), { additionalProperties: false, minProperties: 1 }) } },
    async (request, reply) => {
      const { id } = request.params;
      await readProject(pool, request, id);
      await change(pool, request, {
        table: 'project',
        kind: 'project',
        id,
        render: renderProject,
        context: row => ({ projectId: String(row.id) }),
        set: before => {
          mayManage(request, before.kind);
          if (before.kind === 'launch' && request.body.marketCode === null)
            throw invalid([{ path: 'marketCode', code: 'required', message: 'A launch needs a market.' }]);
          return columnsOf(request.body);
        },
      });
      return withEtag(reply, renderProject(await readProject(pool, request, id)));
    },
  );

  app.delete('/projects/:id', { config: { access: MANAGERS }, schema: { params: WsId } }, async (request, reply) => {
    await readProject(pool, request, request.params.id);
    await remove(pool, request, {
      table: 'project',
      kind: 'project',
      id: request.params.id,
      render: renderProject,
      context: row => ({ projectId: String(row.id) }),
    });
    return reply.code(204).send();
  });

  /** PUT of one of the project's sets, at the project's version; the project's version moves on. */
  async function replaceSet(
    request: FastifyRequest<{ Params: { id: string } }>,
    field: string,
    write: (client: pg.PoolClient, projectId: string) => Promise<void>,
  ) {
    const { id } = request.params;
    const version = ifMatch(request);
    const before = renderProject(await readProject(pool, request, id));
    await tx(pool, async client => {
      await lockRow(client, 'project', id, workspaceOf(request).id, version, renderProject);
      await write(client, id);
      const after = await updateRow(client, 'project', id, {});
      const now = renderProject(await readProject(client, request, id));
      await record(client, request, {
        verb: 'updated',
        entityKind: 'project',
        entityId: id,
        entityVersion: Number(after.version),
        projectId: id,
        changes: diff(before, now, [field]),
      });
    });
    return renderProject(await readProject(pool, request, id));
  }

  app.put(
    '/projects/:id/stores',
    {
      config: { access: MANAGERS },
      schema: {
        params: WsId,
        querystring: Type.Object({ force: Type.Optional(Type.Boolean()) }),
        body: Type.Object({ stores: StoreSlots }, { additionalProperties: false }),
      },
    },
    async (request, reply) =>
      withEtag(reply, await replaceSet(request, 'stores', (client, id) => setStores(client, request, id, request.body.stores, request.query.force ?? false))),
  );

  app.put(
    '/projects/:id/references',
    {
      config: { access: MANAGERS },
      schema: { params: WsId, body: Type.Object({ referenceIds: Type.Array(Id, { maxItems: 50 }) }, { additionalProperties: false }) },
    },
    async (request, reply) =>
      withEtag(
        reply,
        await replaceSet(request, 'referenceIds', async (client, id) => {
          const visible = await readProjects(client, request, 'p.id = any($4)', [request.body.referenceIds]);
          if (visible.length !== new Set(request.body.referenceIds).size || request.body.referenceIds.includes(id)) {
            throw invalid([{ path: 'referenceIds', code: 'unknown_ref', message: 'Every reference must be another project in this workspace.' }]);
          }
          await client.query('delete from launch_reference where project_id = $1', [id]);
          await client.query('insert into launch_reference (project_id, reference_id) select $1, unnest($2::uuid[])', [
            id,
            [...new Set(request.body.referenceIds)],
          ]);
        }),
      ),
  );

  app.put(
    '/projects/:id/members',
    {
      config: { access: MANAGERS },
      schema: { params: WsId, body: Type.Object({ memberIds: Type.Array(Id, { maxItems: 500 }) }, { additionalProperties: false }) },
    },
    async (request, reply) =>
      withEtag(
        reply,
        await replaceSet(request, 'memberIds', async (client, id) => {
          const ids = [...new Set(request.body.memberIds)];
          const members = await client.query('select 1 from workspace_member where workspace_id = $1 and user_id = any($2) and deleted_at is null', [
            workspaceOf(request).id,
            ids,
          ]);
          if (members.rowCount !== ids.length)
            throw invalid([{ path: 'memberIds', code: 'unknown_ref', message: 'Every project member must be a member of this workspace.' }]);
          await client.query('delete from project_member where project_id = $1', [id]);
          await client.query('insert into project_member (project_id, user_id) select $1, unnest($2::uuid[])', [id, ids]);
        }),
      ),
  );

  // ---------- milestones ----------
  const MilestoneFields = { name: Type.String({ minLength: 1, maxLength: 200 }), date: DateOnly, storeId: Type.Optional(Nullable(Id)) };
  const renderMilestone = (row: Row) => toApi(row);

  app.post(
    '/projects/:id/milestones',
    { config: { access: MANAGERS }, schema: { params: WsId, body: Type.Object(MilestoneFields, { additionalProperties: false }) } },
    (request, reply) =>
      created(pool, request, reply, async () => {
        const projectId = request.params.id;
        await readProject(pool, request, projectId);
        const row = await tx(pool, async client => {
          const milestone = await insertRow(client, 'milestone', { project_id: projectId, ...columnsOf(request.body) });
          await record(client, request, { verb: 'created', entityKind: 'milestone', entityId: String(milestone.id), entityVersion: 1, projectId });
          return milestone;
        });
        return { body: renderMilestone(row), location: `/api/v1/w/${workspaceOf(request).slug}/milestones/${String(row.id)}` };
      }),
  );

  const milestoneContext = (row: Row) => ({ projectId: String(row.project_id) });
  app.patch(
    '/milestones/:id',
    {
      config: { access: MANAGERS },
      schema: { params: WsId, body: Type.Partial(Type.Object(MilestoneFields), { additionalProperties: false, minProperties: 1 }) },
    },
    async (request, reply) =>
      withEtag(
        reply,
        await change(pool, request, {
          table: 'milestone',
          kind: 'milestone',
          id: request.params.id,
          render: renderMilestone,
          context: milestoneContext,
          set: () => columnsOf(request.body),
        }),
      ),
  );

  app.delete('/milestones/:id', { config: { access: MANAGERS }, schema: { params: WsId } }, async (request, reply) => {
    await remove(pool, request, { table: 'milestone', kind: 'milestone', id: request.params.id, render: renderMilestone, context: milestoneContext });
    return reply.code(204).send();
  });
  done();
}
