import { setTimeout as sleep } from 'node:timers/promises';
import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { isAdmin } from '../../access/policy.js';
import type { Db } from '../../db/tx.js';
import { workspaceOf } from '../context.js';
import { toApi, type Row } from '../http.js';
import type { ApiOptions } from '../plugin.js';
import { ApiError } from '../problem.js';
import { ACTIVITY_SELECT, renderActivity } from './records.js';
import { readProjects, renderProject, VISIBLE } from './projects.js';
import { readTasks, renderTask } from './tasks.js';
import { renderNotification } from './me.js';
import { MEMBER_SELECT, renderMember, renderTeam, TEAM_SELECT } from './workspaces.js';

/** A project-scoped row the caller may see: `r.project_id` null or a visible, live project. `$1` user, `$2` admin. */
const IN_VISIBLE_PROJECT = `(r.project_id is null or exists (select 1 from project p where p.id = r.project_id and p.deleted_at is null and ${VISIBLE}))`;

/**
 * Everything the offline cache holds, per kind: the table, which rows of the workspace the caller may see
 * (`$1` user, `$2` admin, `$3` workspace), and how to read them whole. Margins and contacts are not here, ever.
 */
interface Kind {
  kind: string;
  /** bootstrap's key */
  list: string;
  table: string;
  id?: string;
  where: string;
  read?: (db: Db, request: FastifyRequest, ids: unknown[]) => Promise<unknown[]>;
}

const KINDS: Kind[] = [
  { kind: 'workspace', list: 'workspace', table: 'workspace', where: 'r.id = $3' },
  {
    kind: 'member',
    list: 'members',
    table: 'workspace_member',
    id: 'user_id',
    where: 'r.workspace_id = $3',
    read: async (db, request, ids) =>
      (await db.query<Row>(`${MEMBER_SELECT} where m.workspace_id = $1 and m.user_id = any($2) order by u.name`, [workspaceOf(request).id, ids])).rows.map(
        renderMember,
      ),
  },
  {
    kind: 'team',
    list: 'teams',
    table: 'team',
    where: 'r.workspace_id = $3',
    read: async (db, request, ids) =>
      (await db.query<Row>(`${TEAM_SELECT} where t.workspace_id = $1 and t.id = any($2) order by t.name`, [workspaceOf(request).id, ids])).rows.map(renderTeam),
  },
  { kind: 'template', list: 'templates', table: 'template', where: 'r.workspace_id = $3' },
  { kind: 'field', list: 'fields', table: 'field_def', where: 'r.workspace_id = $3' },
  { kind: 'list', list: 'lists', table: 'value_list', where: 'r.workspace_id = $3' },
  { kind: 'option', list: 'options', table: 'list_option', where: 'exists (select 1 from value_list l where l.id = r.list_id and l.workspace_id = $3)' },
  { kind: 'store', list: 'stores', table: 'store', where: 'r.workspace_id = $3' },
  { kind: 'capacity', list: 'capacity', table: 'store_capacity', where: 'r.workspace_id = $3' },
  {
    kind: 'project',
    list: 'projects',
    table: 'project',
    where: `r.workspace_id = $3 and (not r.private or $2::boolean or exists (select 1 from project_member pm where pm.project_id = r.id and pm.user_id = $1))`,
    read: async (db, request, ids) => (await readProjects(db, request, 'p.id = any($4) order by p.name', [ids])).map(renderProject),
  },
  {
    kind: 'milestone',
    list: 'milestones',
    table: 'milestone',
    where: `exists (select 1 from project q where q.id = r.project_id and q.workspace_id = $3) and ${IN_VISIBLE_PROJECT}`,
  },
  {
    kind: 'task',
    list: 'tasks',
    table: 'task',
    where: `r.workspace_id = $3 and ${IN_VISIBLE_PROJECT}`,
    read: async (db, request, ids) => (await readTasks(db, request, 't.id = any($4)', [ids], 'order by t.key', ['stores'])).map(renderTask),
  },
  {
    kind: 'lineStore',
    list: 'lineStores',
    table: 'line_store',
    where: `r.workspace_id = $3 and exists (select 1 from task t where t.id = r.task_id and ${IN_VISIBLE_PROJECT.replaceAll('r.project_id', 't.project_id')})`,
  },
  {
    kind: 'subtask',
    list: 'subtasks',
    table: 'subtask',
    where: `exists (select 1 from task t where t.id = r.task_id and t.workspace_id = $3 and ${IN_VISIBLE_PROJECT.replaceAll('r.project_id', 't.project_id')})`,
  },
  { kind: 'brand', list: 'brands', table: 'brand', where: 'r.workspace_id = $3' },
  { kind: 'brandMarket', list: 'brandMarkets', table: 'brand_market', where: 'r.workspace_id = $3' },
  { kind: 'vendor', list: 'vendors', table: 'vendor', where: 'r.workspace_id = $3' },
  { kind: 'install', list: 'installs', table: 'install', where: `r.workspace_id = $3 and ${IN_VISIBLE_PROJECT}` },
  { kind: 'vendorPack', list: 'vendorPacks', table: 'vendor_pack', where: `r.workspace_id = $3 and ${IN_VISIBLE_PROJECT}` },
  { kind: 'brandList', list: 'brandLists', table: 'brand_list_entry', where: `r.workspace_id = $3 and ${IN_VISIBLE_PROJECT}` },
  { kind: 'event', list: 'events', table: 'event', where: `r.workspace_id = $3 and ${IN_VISIBLE_PROJECT}` },
  { kind: 'visitBrand', list: 'visitBrands', table: 'visit_brand', where: `r.workspace_id = $3 and ${IN_VISIBLE_PROJECT}` },
  { kind: 'file', list: 'files', table: 'file', where: `r.workspace_id = $3 and ${IN_VISIBLE_PROJECT}` },
  {
    kind: 'savedView',
    list: 'savedViews',
    table: 'saved_view',
    where: `r.workspace_id = $3 and (r.owner_id is null or r.owner_id = $1) and ${IN_VISIBLE_PROJECT}`,
  },
  {
    kind: 'notification',
    list: 'notifications',
    table: 'notification',
    where: 'r.workspace_id = $3 and r.user_id = $1',
    read: async (db, _request, ids) =>
      (await db.query<Row>('select * from notification where id = any($1) order by created_at desc', [ids])).rows.map(renderNotification),
  },
];
/** Tables without deleted_at: their rows are archived or never removed. */
const NO_TOMBSTONE = new Set(['workspace', 'list_option', 'notification']);
/** Not listed whole in bootstrap: line × store rows and subtasks come inside their tasks; notifications are the latest 200. */
const NOT_IN_BOOTSTRAP = new Set(['notification', 'lineStore', 'subtask']);

/** Types the caller parameters for kinds whose filter does not use all three. */
const CALLER = 'with caller as (select $1::uuid, $2::boolean, $3::uuid)';

const live = (kind: Kind) => (NO_TOMBSTONE.has(kind.table) ? 'true' : 'r.deleted_at is null');

async function readKind(db: Db, request: FastifyRequest, kind: Kind, ids: unknown[]) {
  if (kind.read) return kind.read(db, request, ids);
  return (await db.query<Row>(`select * from ${kind.table} where ${kind.id ?? 'id'} = any($1)`, [ids])).rows.map(toApi);
}

/** How long a change feed waits for writes that were in flight when it started, before it asks the client to come back. */
const SETTLE_TIMEOUT_MS = 5000;

/**
 * The highest change_seq below which every row is committed. A writer takes its change_seq inside its transaction,
 * so a lower number can commit after a higher one; reading past it would skip that row for good. So: read the
 * sequence, then wait for every transaction open in this database at that moment to end.
 */
async function settledSeq(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ seq: number }>('select case when is_called then last_value else last_value - 1 end as seq from change_seq');
  const open = await pool.query<{ vxid: string }>(
    `select l.virtualxid as vxid from pg_locks l join pg_stat_activity a on a.pid = l.pid
      where l.locktype = 'virtualxid' and l.granted and l.pid <> pg_backend_pid() and a.datname = current_database()`,
  );
  const waiting = open.rows.map(row => row.vxid);
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  while (waiting.length > 0) {
    const still = await pool.query(`select 1 from pg_locks where locktype = 'virtualxid' and granted and virtualxid = any($1) limit 1`, [waiting]);
    if (!still.rowCount) break;
    if (Date.now() > deadline) throw new ApiError(503, 'unavailable', 'A large change is still being saved. Try again in a few seconds; nothing was lost.');
    await sleep(25);
  }
  return rows[0]?.seq ?? 0;
}

export function sync(plain: FastifyInstance, { pool }: ApiOptions, done: () => void) {
  const app = plain.withTypeProvider<TypeBoxTypeProvider>();
  const scope = (request: FastifyRequest) => {
    const workspace = workspaceOf(request);
    return [workspace.actor.userId, isAdmin(workspace.actor), workspace.id];
  };

  app.get('/bootstrap', { config: { access: 'any' }, schema: { params: Type.Object({ ws: Type.String() }) } }, async request => {
    const changeSeq = await settledSeq(pool);
    const client = await pool.connect();
    try {
      // One snapshot for the whole response, so the lists agree with each other.
      await client.query('begin isolation level repeatable read read only');
      const out: Record<string, unknown> = { changeSeq };
      for (const kind of KINDS.filter(k => !NOT_IN_BOOTSTRAP.has(k.kind))) {
        const ids = await client.query<{ id: unknown }>(
          `${CALLER} select r.${kind.id ?? 'id'} as id from ${kind.table} r where ${live(kind)} and ${kind.where}`,
          scope(request),
        );
        out[kind.list] = await readKind(
          client,
          request,
          kind,
          ids.rows.map(row => row.id),
        );
      }
      out.workspace = (out.workspace as unknown[])[0] ?? null;
      out.markets = (await client.query<Row>('select * from market order by code')).rows.map(toApi);
      out.favourites = (
        await client.query<{ kind: string; id: string }>('select entity_kind as kind, entity_id as id from favourite where user_id = $1 order by created_at', [
          scope(request)[0],
        ])
      ).rows;
      out.notifications = (
        await client.query<Row>('select * from notification where workspace_id = $1 and user_id = $2 order by created_at desc, id desc limit 200', [
          workspaceOf(request).id,
          scope(request)[0],
        ])
      ).rows.map(renderNotification);
      out.activity = (await client.query<Row>(`${ACTIVITY_SELECT} order by a.id desc limit 200`, scope(request))).rows.map(
        renderActivity(workspaceOf(request)),
      );
      await client.query('commit');
      return out;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  });

  app.get(
    '/changes',
    {
      config: { access: 'any' },
      schema: {
        params: Type.Object({ ws: Type.String() }),
        querystring: Type.Object(
          { since: Type.Integer({ minimum: 0 }), limit: Type.Integer({ minimum: 1, maximum: 5000, default: 1000 }) },
          { additionalProperties: false },
        ),
      },
    },
    async request => {
      const { since, limit } = request.query;
      const until = await settledSeq(pool);
      // Each kind's first limit + 1 changes; merged, the first `limit` overall are exact.
      const found: { kind: Kind; id: unknown; seq: number; deleted: boolean }[] = [];
      for (const kind of KINDS) {
        const { rows } = await pool.query<{ id: unknown; seq: number; deleted: boolean }>(
          `${CALLER} select r.${kind.id ?? 'id'} as id, r.change_seq as seq, ${NO_TOMBSTONE.has(kind.table) ? 'false' : 'r.deleted_at is not null'} as deleted
             from ${kind.table} r where r.change_seq > $4 and r.change_seq <= $5 and ${kind.where} order by r.change_seq limit $6`,
          [...scope(request), since, until, limit + 1],
        );
        found.push(...rows.map(row => ({ kind, ...row })));
      }
      found.sort((a, b) => a.seq - b.seq);
      const items = found.slice(0, limit);
      const hasMore = found.length > limit;
      const data = new Map<string, unknown>();
      for (const kind of KINDS) {
        const ids = items.filter(item => item.kind === kind && !item.deleted).map(item => item.id);
        if (ids.length === 0) continue;
        const rows = (await readKind(pool, request, kind, ids)) as Row[];
        for (const row of rows) data.set(`${kind.kind}/${String(kind.kind === 'member' ? (row.user as Row).id : row.id)}`, row);
      }
      return {
        items: items.map(item => ({
          kind: item.kind.kind,
          id: item.id,
          changeSeq: item.seq,
          deleted: item.deleted,
          data: item.deleted ? null : (data.get(`${item.kind.kind}/${String(item.id)}`) ?? null),
        })),
        nextSince: hasMore ? (items.at(-1)?.seq ?? since) : until,
        hasMore,
      };
    },
  );
  done();
}
