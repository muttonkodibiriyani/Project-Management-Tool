import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { isAdmin, isManager, seesContacts, seesMargins } from '../../access/policy.js';
import { tx } from '../../db/tx.js';
import { workspaceOf, type Workspace } from '../context.js';
import { contains, decodeCursor, isKeyset, isOffset, page, toApi, withEtag, type Row } from '../http.js';
import type { ApiOptions } from '../plugin.js';
import { forbidden, invalid } from '../problem.js';
import { change, columnsOf, created, insertRow, record, remove } from '../rows.js';
import { Id, Limit, Ws, WsId } from '../schemas.js';
import { VISIBLE } from './projects.js';

/** Activity of private projects stays with the people who may see them; margin and contact changes only for those allowed. */
export function renderActivity(workspace: Workspace) {
  const hidden = new Set([
    ...(seesMargins(workspace.settings, workspace.actor) ? [] : ['margin']),
    ...(seesContacts(workspace.settings, workspace.actor) ? [] : ['contact']),
  ]);
  return (row: Row) => {
    const { sensitivity, changes, ...entry } = toApi(row);
    return hidden.has(String(sensitivity)) ? { ...entry, redacted: true } : { ...entry, changes };
  };
}

/** `$1` user, `$2` admin, `$3` workspace. */
export const ACTIVITY_SELECT = `
  select a.id, a.project_id, a.task_id, a.actor_id, a.verb, a.entity_kind, a.entity_id, a.entity_version, a.changes, a.extra, a.sensitivity, a.at
    from activity a left join project p on p.id = a.project_id
   where a.workspace_id = $3 and (a.project_id is null or ${VISIBLE})`;

const ViewType = Type.Enum(['list', 'board', 'table', 'calendar', 'timeline', 'files', 'overview']);
const ViewFields = {
  name: Type.String({ minLength: 1, maxLength: 200 }),
  type: ViewType,
  config: Type.Record(Type.String(), Type.Unknown()),
};

const CATEGORIES = ['tasks', 'projects', 'members', 'files', 'brands', 'vendors'] as const;

export function records(plain: FastifyInstance, { pool }: ApiOptions, done: () => void) {
  const app = plain.withTypeProvider<TypeBoxTypeProvider>();
  const scope = (request: FastifyRequest) => {
    const workspace = workspaceOf(request);
    return [workspace.actor.userId, isAdmin(workspace.actor), workspace.id];
  };

  // ---------- activity ----------
  app.get(
    '/activity',
    {
      config: { access: 'any' },
      schema: {
        params: Ws,
        querystring: Type.Object(
          {
            projectId: Type.Optional(Id),
            taskId: Type.Optional(Id),
            actorId: Type.Optional(Id),
            before: Type.Optional(Type.Integer({ minimum: 1 })),
            limit: Limit(100),
            cursor: Type.Optional(Type.String({ maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async request => {
      const { projectId, taskId, actorId, before, limit, cursor } = request.query;
      const until = decodeCursor(cursor, isOffset) ?? before ?? null;
      const { rows } = await pool.query<Row>(
        `${ACTIVITY_SELECT} and ($4::uuid is null or a.project_id = $4) and ($5::uuid is null or a.task_id = $5) and ($6::uuid is null or a.actor_id = $6)
           and ($7::bigint is null or a.id < $7) order by a.id desc limit $8`,
        [...scope(request), projectId ?? null, taskId ?? null, actorId ?? null, until, limit + 1],
      );
      return page(rows, limit, last => Number(last.id), renderActivity(workspaceOf(request)));
    },
  );

  // ---------- saved views ----------
  const renderView = (row: Row) => toApi(row);
  /** Own views are their owner's; shared views (no owner) are run by LM and ADM. */
  const mayChangeView = (request: FastifyRequest, ownerId: unknown) => {
    const actor = workspaceOf(request).actor;
    if (ownerId === null ? !isManager(actor) : ownerId !== actor.userId)
      throw forbidden(ownerId === null ? 'Only Launch managers and admins change shared views.' : 'This view is someone else’s.');
  };
  const viewContext = (row: Row) => ({ projectId: (row.project_id as string | null) ?? null });

  app.get(
    '/views',
    {
      config: { access: 'any' },
      schema: {
        params: Ws,
        querystring: Type.Object(
          { projectId: Type.Optional(Id), limit: Limit(100), cursor: Type.Optional(Type.String({ maxLength: 200 })) },
          { additionalProperties: false },
        ),
      },
    },
    async request => {
      const { projectId, limit, cursor } = request.query;
      const after = decodeCursor(cursor, isKeyset);
      const { rows } = await pool.query<Row>(
        `select v.* from saved_view v left join project p on p.id = v.project_id
          where v.workspace_id = $3 and v.deleted_at is null and (v.owner_id is null or v.owner_id = $1) and (v.project_id is null or (p.deleted_at is null and ${VISIBLE}))
            and ($4::uuid is null or v.project_id = $4) and ($5::text is null or (v.name, v.id) > ($5, $6::uuid))
          order by v.name, v.id limit $7`,
        [...scope(request), projectId ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
      );
      return page(rows, limit, last => [String(last.name), String(last.id)], renderView);
    },
  );

  app.post(
    '/views',
    {
      config: { access: 'any' },
      schema: {
        params: Ws,
        body: Type.Object(
          {
            ...ViewFields,
            config: Type.Optional(ViewFields.config),
            projectId: Type.Optional(Type.Union([Id, Type.Null()])),
            ownerId: Type.Optional(Type.Union([Id, Type.Null()])),
          },
          { additionalProperties: false },
        ),
      },
    },
    (request, reply) =>
      created(pool, request, reply, async () => {
        const workspace = workspaceOf(request);
        const { ownerId = workspace.actor.userId, projectId = null, ...fields } = request.body;
        mayChangeView(request, ownerId);
        if (projectId) {
          const visible = await pool.query(`select 1 from project p where p.id = $4 and p.workspace_id = $3 and p.deleted_at is null and ${VISIBLE}`, [
            ...scope(request),
            projectId,
          ]);
          if (!visible.rowCount) throw invalid([{ path: 'projectId', code: 'unknown_ref', message: 'The project does not exist, or you may not see it.' }]);
        }
        const row = await tx(pool, async client => {
          const view = await insertRow(client, 'saved_view', { workspace_id: workspace.id, owner_id: ownerId, project_id: projectId, ...columnsOf(fields) });
          await record(client, request, { verb: 'created', entityKind: 'saved_view', entityId: String(view.id), entityVersion: 1, projectId });
          return view;
        });
        return { body: renderView(row), location: `/api/v1/w/${workspace.slug}/views/${String(row.id)}` };
      }),
  );

  app.patch(
    '/views/:id',
    { config: { access: 'any' }, schema: { params: WsId, body: Type.Partial(Type.Object(ViewFields), { additionalProperties: false, minProperties: 1 }) } },
    async (request, reply) =>
      withEtag(
        reply,
        await change(pool, request, {
          table: 'saved_view',
          kind: 'saved_view',
          id: request.params.id,
          render: renderView,
          context: viewContext,
          set: before => {
            mayChangeView(request, before.owner_id);
            return columnsOf(request.body, ['config']);
          },
        }),
      ),
  );

  app.delete('/views/:id', { config: { access: 'any' }, schema: { params: WsId } }, async (request, reply) => {
    await remove(pool, request, {
      table: 'saved_view',
      kind: 'saved_view',
      id: request.params.id,
      render: renderView,
      context: viewContext,
      check: row => {
        mayChangeView(request, row.owner_id);
      },
    });
    return reply.code(204).send();
  });

  // ---------- search (command palette) ----------
  app.get(
    '/search',
    {
      config: { access: 'any' },
      schema: {
        params: Ws,
        querystring: Type.Object(
          { q: Type.String({ minLength: 1, maxLength: 200 }), cat: Type.Optional(Type.Enum(['all', ...CATEGORIES])), limit: Limit(20) },
          { additionalProperties: false },
        ),
      },
    },
    async request => {
      const { q, cat = 'all', limit } = request.query;
      const like = contains(q);
      const visible = [...scope(request), like, limit];
      const plain = [workspaceOf(request).id, like, limit];
      const queries: Record<(typeof CATEGORIES)[number], [string, unknown[]]> = {
        tasks: [
          `select t.id, t.key, t.title, t.project_id, t.status from task t join project p on p.id = t.project_id and p.deleted_at is null
            where t.workspace_id = $3 and t.deleted_at is null and ${VISIBLE} and (t.key ilike $4 or t.title ilike $4) order by t.updated_at desc, t.id limit $5`,
          visible,
        ],
        projects: [
          `select p.id, p.key, p.name from project p where p.workspace_id = $3 and p.deleted_at is null and ${VISIBLE} and (p.key ilike $4 or p.name ilike $4) order by p.name, p.id limit $5`,
          visible,
        ],
        members: [
          `select u.id, u.name, u.email from workspace_member m join app_user u on u.id = m.user_id
            where m.workspace_id = $1 and m.deleted_at is null and (u.name ilike $2 or u.email ilike $2) order by u.name, u.id limit $3`,
          plain,
        ],
        files: [
          `select f.id, f.name, f.project_id from file f join project p on p.id = f.project_id and p.deleted_at is null
            where f.workspace_id = $3 and f.deleted_at is null and ${VISIBLE} and f.name ilike $4 order by f.created_at desc, f.id limit $5`,
          visible,
        ],
        brands: [
          'select b.id, b.name from brand b where b.workspace_id = $1 and b.deleted_at is null and b.name ilike $2 order by b.name, b.id limit $3',
          plain,
        ],
        vendors: [
          'select v.id, v.name from vendor v where v.workspace_id = $1 and v.deleted_at is null and v.name ilike $2 order by v.name, v.id limit $3',
          plain,
        ],
      };
      const results: Record<string, unknown[]> = {};
      for (const category of CATEGORIES) {
        const [sql, params] = queries[category];
        results[category] = cat === 'all' || cat === category ? (await pool.query<Row>(sql, params)).rows.map(toApi) : [];
      }
      return results;
    },
  );
  done();
}
