import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { tx, type Db } from '../db/tx.js';
import { callerOf, workspaceOf } from './context.js';
import { ifMatch, toApi, toColumn, type Row } from './http.js';
import { ApiError, notFound } from './problem.js';

/** Tables without workspace_id reach their workspace through a parent. `$2` is the workspace id. */
const IN_WORKSPACE: Record<string, string> = {
  subtask: 'exists (select 1 from task t where t.id = r.task_id and t.workspace_id = $2)',
  milestone: 'exists (select 1 from project p where p.id = r.project_id and p.workspace_id = $2)',
  list_option: 'exists (select 1 from value_list l where l.id = r.list_id and l.workspace_id = $2)',
};

const sqlName = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`${name} is not a plain SQL name`);
  return name;
};

/**
 * Locks a live row for the rest of the transaction and checks the client's version.
 * Missing (or in another workspace) → 404; version moved on → 409 with the current row, and nothing is written.
 */
export async function lockRow(
  client: pg.PoolClient,
  table: string,
  id: string,
  workspaceId: string,
  version: number | undefined,
  render: (row: Row) => unknown = toApi,
): Promise<Row> {
  const where = IN_WORKSPACE[table] ?? 'r.workspace_id = $2';
  const { rows } = await client.query<Row>(`select r.* from ${sqlName(table)} r where r.id = $1 and ${where} and r.deleted_at is null for update`, [
    id,
    workspaceId,
  ]);
  const row = rows[0];
  if (!row) throw notFound(`This ${table.replace('_', ' ')}`);
  if (version !== undefined && row.version !== version) throw conflict(row, render);
  return row;
}

export const conflict = (row: Row, render: (row: Row) => unknown = toApi) =>
  new ApiError(
    409,
    'version_conflict',
    `Someone else changed this first (now version ${String(row.version)}). Compare your change with theirs, then send it again with If-Match: "${String(row.version)}".`,
    {
      current: render(row),
    },
  );

/** Sets the columns and moves the version on. The row must have been locked with lockRow in this transaction. */
export async function updateRow(client: pg.PoolClient, table: string, id: string, set: Record<string, unknown>): Promise<Row> {
  const columns = Object.keys(set).map(sqlName);
  const assignments = columns.map((column, index) => `${column} = $${index + 2}`);
  const { rows } = await client.query<Row>(`update ${sqlName(table)} set ${[...assignments, 'version = version + 1'].join(', ')} where id = $1 returning *`, [
    id,
    ...columns.map(column => set[column]),
  ]);
  const row = rows[0];
  if (!row) throw new Error(`${table} ${id} vanished after it was locked`);
  return row;
}

export async function insertRow(db: Db, table: string, values: Record<string, unknown>): Promise<Row> {
  const columns = Object.keys(values).map(sqlName);
  const { rows } = await db.query<Row>(
    `insert into ${sqlName(table)} (${columns.join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')}) returning *`,
    columns.map(column => {
      const value = values[column];
      // jsonb columns take objects and arrays as JSON; text[] columns take string arrays as arrays.
      return value !== null && typeof value === 'object' && !(value instanceof Date) && !isStringArray(value) ? JSON.stringify(value) : value;
    }),
  );
  return rows[0] ?? {};
}

const isStringArray = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');

/** Writes jsonb columns as JSON text; leaves the rest. For updateRow's `set`. */
export const json = (value: unknown) => JSON.stringify(value);

export interface Change {
  field: string;
  from: unknown;
  to: unknown;
}

/** Field-level differences between two API objects, `values` key by key. */
export function diff(before: Row, after: Row, fields: string[]): Change[] {
  const changes: Change[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  for (const field of fields) {
    const from = before[field];
    const to = after[field];
    if (field === 'values' && from && to && typeof from === 'object' && typeof to === 'object') {
      const a = from as Row;
      const b = to as Row;
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!same(a[key], b[key])) changes.push({ field: `values.${key}`, from: a[key] ?? null, to: b[key] ?? null });
      }
    } else if (!same(from, to)) {
      changes.push({ field, from: from ?? null, to: to ?? null });
    }
  }
  return changes;
}

export interface ActivityEntry {
  verb: string;
  entityKind: string;
  entityId?: string | null;
  entityVersion?: number | null;
  projectId?: string | null;
  taskId?: string | null;
  changes?: Change[] | null;
  extra?: string | null;
  sensitivity?: 'normal' | 'margin' | 'contact';
}

/** Appends to the activity log in the caller's transaction, so the log and the change commit together. */
export async function record(client: Db, request: FastifyRequest, entry: ActivityEntry): Promise<void> {
  await client.query(
    `insert into activity (workspace_id, project_id, task_id, actor_id, verb, entity_kind, entity_id, entity_version, changes, extra, sensitivity, request_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      workspaceOf(request).id,
      entry.projectId ?? null,
      entry.taskId ?? null,
      callerOf(request).userId,
      entry.verb,
      entry.entityKind,
      entry.entityId ?? null,
      entry.entityVersion ?? null,
      entry.changes ? JSON.stringify(entry.changes) : null,
      entry.extra ?? null,
      entry.sensitivity ?? 'normal',
      request.id,
    ],
  );
}

interface Created {
  body: Row;
  location: string;
}

/**
 * A create that is safe to retry: with `Idempotency-Key` the first response is kept 24 h per user and key,
 * the same request gets it again, and a different request with that key is refused.
 */
export async function created(pool: pg.Pool, request: FastifyRequest, reply: FastifyReply, create: () => Promise<Created>) {
  const key = request.headers['idempotency-key'];
  const send = ({ body, location }: Created) =>
    reply
      .code(201)
      .header('location', location)
      .header('etag', `"${String(body.version)}"`)
      .send(body);
  if (key === undefined) return send(await create());
  if (key.length < 8 || key.length > 80) throw new ApiError(400, 'bad_request', 'Idempotency-Key must be 8 to 80 characters; a uuid is a good choice.');

  const userId = callerOf(request).userId;
  const hash = createHash('sha256')
    .update(`${request.method} ${request.url}\n${JSON.stringify(request.body ?? null)}`)
    .digest();
  const kept = await pool.query<{ request_hash: Buffer; response: Created }>(
    `select request_hash, response from idempotency_key where user_id = $1 and key = $2 and created_at > now() - interval '24 hours'`,
    [userId, key],
  );
  const previous = kept.rows[0];
  if (previous) {
    if (!previous.request_hash.equals(hash)) {
      throw new ApiError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used for a different request. Use a new key for a new change.');
    }
    return send(previous.response);
  }
  const result = await create();
  await pool.query(
    `insert into idempotency_key (user_id, key, request_hash, status, response) values ($1, $2, $3, 201, $4)
     on conflict (user_id, key) do update set request_hash = excluded.request_hash, response = excluded.response, created_at = now()`,
    [userId, key, hash, JSON.stringify(result)],
  );
  return send(result);
}

/** Drops kept responses older than 24 h. Runs at startup and hourly. */
export async function expireIdempotencyKeys(pool: pg.Pool): Promise<void> {
  await pool.query(`delete from idempotency_key where created_at < now() - interval '24 hours'`);
}

/** A body's fields as columns; objects and arrays that live in jsonb are passed as JSON. */
export function columnsOf(body: Record<string, unknown>, jsonFields: readonly string[] = []): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).map(([field, value]) => [toColumn(field), jsonFields.includes(field) ? json(value) : value]));
}

interface Target {
  table: string;
  kind: string;
  id: string;
  render: (row: Row) => Row;
  /** Project and task the activity entry belongs to. */
  context?: (row: Row) => { projectId?: string | null; taskId?: string | null };
}

/**
 * The whole PATCH: lock the row at the client's If-Match version, let `set` check rights and build the columns,
 * write, and log the field diff, all in one transaction.
 */
export async function change(
  pool: pg.Pool,
  request: FastifyRequest,
  target: Target & { set: (before: Row, client: pg.PoolClient) => Promise<Record<string, unknown>> | Record<string, unknown> },
) {
  const version = ifMatch(request);
  return tx(pool, async client => {
    const before = await lockRow(client, target.table, target.id, workspaceOf(request).id, version, target.render);
    const set = await target.set(before, client);
    const after = await updateRow(client, target.table, target.id, set);
    const changes = diff(
      target.render(before),
      target.render(after),
      Object.keys(set).map(column => column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())),
    );
    await record(client, request, {
      verb: 'updated',
      entityKind: target.kind,
      entityId: target.id,
      entityVersion: Number(after.version),
      changes,
      ...target.context?.(after),
    });
    return target.render(after);
  });
}

/** The whole DELETE: soft delete at the client's version (a tombstone for /changes) and log it. */
export async function remove(pool: pg.Pool, request: FastifyRequest, target: Target & { check?: (row: Row, client: pg.PoolClient) => Promise<void> | void }) {
  const version = ifMatch(request);
  await tx(pool, async client => {
    const before = await lockRow(client, target.table, target.id, workspaceOf(request).id, version, target.render);
    await target.check?.(before, client);
    const after = await updateRow(client, target.table, target.id, { deleted_at: new Date() });
    await record(client, request, {
      verb: 'deleted',
      entityKind: target.kind,
      entityId: target.id,
      entityVersion: Number(after.version),
      ...target.context?.(after),
    });
  });
}
