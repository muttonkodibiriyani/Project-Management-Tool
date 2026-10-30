import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import { permissions, type WorkspaceSettings } from '../../access/policy.js';
import { tx } from '../../db/tx.js';
import { callerOf, type Caller } from '../context.js';
import { decodeCursor, ifMatch, isKeyset, mergePatch, page, toApi, withEtag, type Json, type Row } from '../http.js';
import type { ApiOptions } from '../plugin.js';
import { ApiError, notFound } from '../problem.js';
import { conflict, json } from '../rows.js';
import { Id, Limit } from '../schemas.js';

/** User as every endpoint shows it: no prefs (those are the owner's, on /me) and no Entra ids. */
export function renderUser(row: Row) {
  const { id, version, email, name, title, colour, timeZone, status, lastSeenAt, appRoles, createdAt, updatedAt } = toApi(row);
  return { id, version, email, name, title, colour, timeZone, status, lastSeenAt, appRoles, createdAt, updatedAt };
}

const UNREAD = { all: '', unread: 'and n.read_at is null and not n.archived', archived: 'and n.archived' } as const;

export function me(plain: FastifyInstance, { pool }: ApiOptions, done: () => void) {
  const app = plain.withTypeProvider<TypeBoxTypeProvider>();
  const any = { access: 'any' } as const;

  async function profile(caller: Caller) {
    const { rows } = await pool.query<Row & { prefs: Record<string, Json> }>('select * from app_user where id = $1', [caller.userId]);
    const user = rows[0];
    if (!user) throw new ApiError(401, 'unauthenticated', 'Your account no longer exists. Sign in again.');
    const workspaces = await pool.query<{
      id: string;
      slug: string;
      name: string;
      gr8r_role: string;
      settings: WorkspaceSettings;
      teams: string[];
      gates: { key: string; ownerTeam: string | null }[];
    }>(
      `select w.id, w.slug, w.name, m.gr8r_role, w.settings,
              array(select t.key from team_member tm join team t on t.id = tm.team_id
                     where tm.user_id = $1 and t.workspace_id = w.id and t.deleted_at is null order by t.key) as teams,
              coalesce((select json_agg(json_build_object('key', f.key, 'ownerTeam', t.key) order by f.position, f.key)
                          from field_def f left join team t on t.id = f.owner_team_id
                         where f.workspace_id = w.id and f.is_gate and f.deleted_at is null), '[]') as gates
         from workspace_member m join workspace w on w.id = m.workspace_id
        where m.user_id = $1 and m.deleted_at is null order by w.name`,
      [caller.userId],
    );
    return {
      user: renderUser(user),
      prefs: user.prefs,
      workspaces: workspaces.rows.map(w => ({ id: w.id, slug: w.slug, name: w.name, gr8rRole: w.gr8r_role })),
      permissions: Object.fromEntries(
        workspaces.rows.map(w => [w.slug, permissions(w.settings, { userId: caller.userId, roles: caller.roles, teams: w.teams }, w.gates)]),
      ),
      session: { id: caller.sessionId, expiresAt: caller.sessionExpiresAt },
    };
  }

  app.get('/me', { config: any }, async (request, reply) => {
    const body = await profile(callerOf(request));
    reply.header('etag', `"${String(body.user.version)}"`);
    return body;
  });

  app.patch(
    '/me',
    { config: any, schema: { body: Type.Object({ prefs: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: false }) } },
    async (request, reply) => {
      const caller = callerOf(request);
      const version = ifMatch(request);
      await tx(pool, async client => {
        const { rows } = await client.query<Row & { prefs: Record<string, Json> }>('select * from app_user where id = $1 for update', [caller.userId]);
        const user = rows[0];
        if (!user) throw notFound('Your account');
        if (user.version !== version) throw conflict(user, renderUser);
        await client.query('update app_user set prefs = $2, version = version + 1 where id = $1', [
          caller.userId,
          json(mergePatch(user.prefs, request.body.prefs as Record<string, Json>)),
        ]);
      });
      const body = await profile(caller);
      reply.header('etag', `"${String(body.user.version)}"`);
      return body;
    },
  );

  app.get('/me/sessions', { config: any }, async request => {
    const caller = callerOf(request);
    const { rows } = await pool.query<Row>(
      `select id, user_agent, host(ip) as ip, created_at, last_seen_at, expires_at, id = $2 as current
         from user_session where user_id = $1 and revoked_at is null and expires_at > now() order by created_at desc`,
      [caller.userId, caller.sessionId],
    );
    return { items: rows.map(toApi), nextCursor: null };
  });

  app.delete('/me/sessions/:id', { config: any, schema: { params: Type.Object({ id: Id }) } }, async (request, reply) => {
    await pool.query('update user_session set revoked_at = coalesce(revoked_at, now()) where id = $1 and user_id = $2', [
      request.params.id,
      callerOf(request).userId,
    ]);
    return reply.code(204).send();
  });

  const favourite = { params: Type.Object({ kind: Type.Union([Type.Literal('project'), Type.Literal('task'), Type.Literal('saved_view')]), id: Id }) };
  app.put('/me/favourites/:kind/:id', { config: any, schema: favourite }, async (request, reply) => {
    await pool.query('insert into favourite (user_id, entity_kind, entity_id) values ($1, $2, $3) on conflict do nothing', [
      callerOf(request).userId,
      request.params.kind,
      request.params.id,
    ]);
    return reply.code(204).send();
  });
  app.delete('/me/favourites/:kind/:id', { config: any, schema: favourite }, async (request, reply) => {
    await pool.query('delete from favourite where user_id = $1 and entity_kind = $2 and entity_id = $3', [
      callerOf(request).userId,
      request.params.kind,
      request.params.id,
    ]);
    return reply.code(204).send();
  });

  app.get(
    '/me/notifications',
    {
      config: any,
      schema: {
        querystring: Type.Object({
          filter: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('unread'), Type.Literal('archived')])),
          type: Type.Optional(Type.String()),
          ws: Type.Optional(Type.String()),
          limit: Limit(100),
          cursor: Type.Optional(Type.String()),
        }),
      },
    },
    async request => {
      const { filter = 'all', type, ws, limit, cursor } = request.query;
      const after = decodeCursor(cursor, isKeyset);
      const { rows } = await pool.query<Row & { created_at: Date; id: string }>(
        `select n.* from notification n join workspace w on w.id = n.workspace_id
          where n.user_id = $1 ${UNREAD[filter]}
            and ($2::text[] is null or n.type = any($2)) and ($3::text is null or w.slug = $3)
            and ($4::timestamptz is null or (n.created_at, n.id) < ($4, $5::uuid))
          order by n.created_at desc, n.id desc limit $6`,
        [callerOf(request).userId, type ? type.split(',') : null, ws ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
      );
      return page(rows, limit, last => [last.created_at.toISOString(), last.id], renderNotification);
    },
  );

  app.patch(
    '/me/notifications/:id',
    {
      config: any,
      schema: {
        params: Type.Object({ id: Id }),
        body: Type.Object({ read: Type.Optional(Type.Boolean()), archived: Type.Optional(Type.Boolean()) }, { additionalProperties: false, minProperties: 1 }),
      },
    },
    async (request, reply) => {
      const version = ifMatch(request);
      const { read, archived } = request.body;
      const row = await tx(pool, async client => {
        const { rows } = await client.query<Row>('select * from notification where id = $1 and user_id = $2 for update', [
          request.params.id,
          callerOf(request).userId,
        ]);
        const current = rows[0];
        if (!current) throw notFound('This notification');
        if (current.version !== version) throw conflict(current, renderNotification);
        const updated = await client.query<Row>(
          `update notification set read_at = case when $2::boolean is null then read_at when $2 then coalesce(read_at, now()) end,
                  archived = coalesce($3, archived), version = version + 1 where id = $1 returning *`,
          [request.params.id, read ?? null, archived ?? null],
        );
        return updated.rows[0] ?? current;
      });
      return withEtag(reply, renderNotification(row));
    },
  );

  app.post(
    '/me/notifications/read-all',
    { config: any, schema: { body: Type.Object({ ws: Type.Optional(Type.String()) }, { additionalProperties: false }) } },
    async request => {
      const { rowCount } = await pool.query(
        `update notification n set read_at = now(), version = n.version + 1 from workspace w
          where w.id = n.workspace_id and n.user_id = $1 and n.read_at is null and ($2::text is null or w.slug = $2)`,
        [callerOf(request).userId, request.body.ws ?? null],
      );
      return { updated: rowCount ?? 0 };
    },
  );
  done();
}

export function renderNotification(row: Row) {
  const { id, version, type, actorId, taskId, commentId, text, readAt, archived, createdAt } = toApi(row);
  return { id, version, type, actorId, taskId, commentId, text, readAt, archived, createdAt };
}
