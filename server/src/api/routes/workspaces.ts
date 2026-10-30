import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance } from 'fastify';
import { APP_ROLES } from '../../access/policy.js';
import { tx } from '../../db/tx.js';
import { callerOf, workspaceOf } from '../context.js';
import { ifMatch, toApi, withEtag, type Row } from '../http.js';
import type { ApiOptions } from '../plugin.js';
import { ApiError, notFound } from '../problem.js';
import { change, columnsOf, conflict, created, diff, insertRow, record, remove } from '../rows.js';
import { Id, Ws, WsId } from '../schemas.js';
import { renderUser } from './me.js';

const ADMIN = { access: ['Workspace.Admin'] } as const;
const ANY = { access: 'any' } as const;

/** Teams every new workspace starts with; the first four take their members from Entra app roles at sign-in. */
const SEED_TEAMS = [
  { key: 'brand', name: 'Brand', appRole: 'BrandTeam' },
  { key: 'supply', name: 'Supply', appRole: 'Supply' },
  { key: 'vm', name: 'VM', appRole: 'VM' },
  { key: 'comms', name: 'Comms', appRole: 'Comms' },
  { key: 'commercial', name: 'Commercial', appRole: null },
  { key: 'registration', name: 'Registration', appRole: null },
  { key: 'marketing', name: 'Marketing', appRole: null },
];

const AccessSetting = Type.Object({ roles: Type.Array(Type.Enum(APP_ROLES)), teams: Type.Array(Type.String()) }, { additionalProperties: false });
const Settings = Type.Object({ marginAccess: Type.Optional(AccessSetting), contactAccess: Type.Optional(AccessSetting) }, { additionalProperties: false });
const Colour = Type.String({ pattern: '^#[0-9A-Fa-f]{6}$' });
const Gr8rRole = Type.Enum(['Owner', 'Admin', 'Member', 'Guest']);
const TeamFields = {
  name: Type.String({ minLength: 1, maxLength: 80 }),
  icon: Type.Optional(Type.String({ maxLength: 40 })),
  colour: Type.Optional(Colour),
  description: Type.Optional(Type.String({ maxLength: 500 })),
  appRole: Type.Optional(Type.Union([Type.Enum(APP_ROLES), Type.Null()])),
};

export const renderWorkspace = (row: Row) => toApi(row);

export function renderTeam(row: Row) {
  return toApi(row);
}

export const MEMBER_SELECT = `
  select m.gr8r_role, m.version, m.user_id, to_jsonb(u) as user_row,
         array(select t.key from team_member tm join team t on t.id = tm.team_id
                where tm.user_id = m.user_id and t.workspace_id = m.workspace_id and t.deleted_at is null order by t.key) as teams
    from workspace_member m join app_user u on u.id = m.user_id`;

export const renderMember = (row: Row) => ({ user: renderUser(row.user_row as Row), gr8rRole: row.gr8r_role, teams: row.teams, version: row.version });

export const TEAM_SELECT = `
  select t.*, coalesce((select json_agg(json_build_object('userId', tm.user_id, 'source', tm.source) order by tm.created_at)
                          from team_member tm where tm.team_id = t.id), '[]') as members
    from team t`;

export function workspaces(plain: FastifyInstance, { pool }: ApiOptions, done: () => void) {
  const app = plain.withTypeProvider<TypeBoxTypeProvider>();

  async function member(workspaceId: string, userId: string) {
    const { rows } = await pool.query<Row>(`${MEMBER_SELECT} where m.workspace_id = $1 and m.user_id = $2 and m.deleted_at is null`, [workspaceId, userId]);
    if (!rows[0]) throw notFound('This member');
    return renderMember(rows[0]);
  }

  async function team(workspaceId: string, id: string) {
    const { rows } = await pool.query<Row>(`${TEAM_SELECT} where t.workspace_id = $1 and t.id = $2 and t.deleted_at is null`, [workspaceId, id]);
    if (!rows[0]) throw notFound('This team');
    return renderTeam(rows[0]);
  }

  app.get('/workspaces', { config: ANY }, async request => {
    const { rows } = await pool.query<Row>(
      `select w.* from workspace w join workspace_member m on m.workspace_id = w.id and m.user_id = $1 and m.deleted_at is null order by w.name`,
      [callerOf(request).userId],
    );
    return { items: rows.map(renderWorkspace), nextCursor: null };
  });

  app.post(
    '/workspaces',
    {
      config: ADMIN,
      schema: {
        body: Type.Object(
          { slug: Type.String({ pattern: '^[a-z0-9-]{2,40}$' }), name: Type.String({ minLength: 1, maxLength: 120 }) },
          { additionalProperties: false },
        ),
      },
    },
    (request, reply) =>
      created(pool, request, reply, () =>
        tx(pool, async client => {
          const userId = callerOf(request).userId;
          const workspace = await insertRow(client, 'workspace', { slug: request.body.slug, name: request.body.name });
          await insertRow(client, 'workspace_member', { workspace_id: workspace.id, user_id: userId, gr8r_role: 'Owner' });
          for (const seed of SEED_TEAMS)
            await insertRow(client, 'team', { workspace_id: workspace.id, key: seed.key, name: seed.name, app_role: seed.appRole });
          request.workspace = { id: String(workspace.id), slug: request.body.slug, settings: {}, actor: { userId, roles: callerOf(request).roles, teams: [] } };
          await record(client, request, { verb: 'created', entityKind: 'workspace', entityId: String(workspace.id), entityVersion: 1 });
          return { body: renderWorkspace(workspace), location: `/api/v1/w/${request.body.slug}` };
        }),
      ),
  );

  app.get('/w/:ws', { config: ANY, schema: { params: Ws } }, async (request, reply) => {
    const { rows } = await pool.query<Row>('select * from workspace where id = $1', [workspaceOf(request).id]);
    return withEtag(reply, renderWorkspace(rows[0] ?? {}));
  });

  app.patch(
    '/w/:ws',
    {
      config: ADMIN,
      schema: {
        params: Ws,
        body: Type.Object(
          { name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })), colour: Type.Optional(Colour), settings: Type.Optional(Settings) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const version = ifMatch(request);
      const after = await tx(pool, async client => {
        const { rows } = await client.query<Row>('select * from workspace where id = $1 for update', [workspaceOf(request).id]);
        const before = rows[0] ?? {};
        if (before.version !== version) throw conflict(before, renderWorkspace);
        const set = columnsOf(request.body, ['settings']);
        const columns = Object.keys(set);
        const updated = await client.query<Row>(
          `update workspace set ${[...columns.map((column, index) => `${column} = $${index + 2}`), 'version = version + 1'].join(', ')} where id = $1 returning *`,
          [before.id, ...columns.map(column => set[column])],
        );
        const row = updated.rows[0] ?? before;
        await record(client, request, {
          verb: 'updated',
          entityKind: 'workspace',
          entityId: String(row.id),
          entityVersion: Number(row.version),
          changes: diff(toApi(before), toApi(row), Object.keys(request.body)),
        });
        return row;
      });
      return withEtag(reply, renderWorkspace(after));
    },
  );

  // ---------- members ----------
  app.get(
    '/w/:ws/members',
    { config: ANY, schema: { params: Ws, querystring: Type.Object({ q: Type.Optional(Type.String()), team: Type.Optional(Type.String()) }) } },
    async request => {
      const { q, team: teamKey } = request.query;
      const { rows } = await pool.query<Row>(
        `${MEMBER_SELECT}
          where m.workspace_id = $1 and m.deleted_at is null
            and ($2::text is null or u.name ilike '%' || $2 || '%' or u.email::text ilike '%' || $2 || '%')
            and ($3::text is null or exists (select 1 from team_member tm join team t on t.id = tm.team_id
                                              where tm.user_id = m.user_id and t.workspace_id = m.workspace_id and t.key = $3))
          order by u.name, u.id`,
        [workspaceOf(request).id, q ?? null, teamKey ?? null],
      );
      return { items: rows.map(renderMember), nextCursor: null };
    },
  );

  app.post(
    '/w/:ws/members',
    {
      config: ADMIN,
      schema: {
        params: Ws,
        body: Type.Object({ email: Type.String({ format: 'email', maxLength: 254 }), gr8rRole: Type.Optional(Gr8rRole) }, { additionalProperties: false }),
      },
    },
    (request, reply) =>
      created(pool, request, reply, () =>
        tx(pool, async client => {
          const workspaceId = workspaceOf(request).id;
          // An invite: the person becomes active at their first sign-in, matched by e-mail.
          const user = await client.query<{ id: string }>(
            `insert into app_user (email, name, status) values ($1::citext, split_part($1, '@', 1), 'invited')
             on conflict (email) do update set email = app_user.email returning id`,
            [request.body.email],
          );
          const userId = user.rows[0]?.id ?? '';
          const { rowCount } = await client.query(
            `insert into workspace_member (workspace_id, user_id, gr8r_role, invited_by) values ($1, $2, $3, $4)
             on conflict (workspace_id, user_id) do update set deleted_at = null, gr8r_role = excluded.gr8r_role, invited_by = excluded.invited_by, version = workspace_member.version + 1
             where workspace_member.deleted_at is not null`,
            [workspaceId, userId, request.body.gr8rRole ?? 'Member', callerOf(request).userId],
          );
          if (rowCount === 0) {
            throw new ApiError(409, 'duplicate', `${request.body.email} is already a member of this workspace.`, {
              errors: [{ path: 'email', code: 'duplicate', message: 'Already a member.' }],
            });
          }
          await record(client, request, {
            verb: 'created',
            entityKind: 'member',
            entityId: userId,
            entityVersion: 1,
            extra: request.body.gr8rRole ?? 'Member',
          });
          const { rows } = await client.query<Row>(`${MEMBER_SELECT} where m.workspace_id = $1 and m.user_id = $2`, [workspaceId, userId]);
          return { body: renderMember(rows[0] ?? {}), location: `/api/v1/w/${workspaceOf(request).slug}/members/${userId}` };
        }),
      ),
  );

  const MemberParams = Type.Object({ ws: Type.String(), userId: Id });

  /** Locks the membership at the client's version, and refuses to leave the workspace without an Owner. */
  async function lockMember(client: import('pg').PoolClient, workspaceId: string, userId: string, version: number, nextRole: string | null) {
    const { rows } = await client.query<Row>(`${MEMBER_SELECT} where m.workspace_id = $1 and m.user_id = $2 and m.deleted_at is null for update of m`, [
      workspaceId,
      userId,
    ]);
    const row = rows[0];
    if (!row) throw notFound('This member');
    if (row.version !== version) throw conflict(row, renderMember);
    if (row.gr8r_role === 'Owner' && nextRole !== 'Owner') {
      const owners = await client.query(
        `select 1 from workspace_member where workspace_id = $1 and gr8r_role = 'Owner' and deleted_at is null and user_id <> $2`,
        [workspaceId, userId],
      );
      if (owners.rowCount === 0) {
        throw new ApiError(422, 'validation_failed', 'A workspace needs an Owner. Make someone else Owner first.', {
          errors: [{ path: 'gr8rRole', code: 'required', message: 'The last Owner cannot be removed.' }],
        });
      }
    }
    return row;
  }

  app.patch(
    '/w/:ws/members/:userId',
    { config: ADMIN, schema: { params: MemberParams, body: Type.Object({ gr8rRole: Gr8rRole }, { additionalProperties: false }) } },
    async (request, reply) => {
      const version = ifMatch(request);
      const workspaceId = workspaceOf(request).id;
      await tx(pool, async client => {
        const before = await lockMember(client, workspaceId, request.params.userId, version, request.body.gr8rRole);
        await client.query('update workspace_member set gr8r_role = $3, version = version + 1 where workspace_id = $1 and user_id = $2', [
          workspaceId,
          request.params.userId,
          request.body.gr8rRole,
        ]);
        await record(client, request, {
          verb: 'updated',
          entityKind: 'member',
          entityId: request.params.userId,
          entityVersion: version + 1,
          changes: [{ field: 'gr8rRole', from: before.gr8r_role, to: request.body.gr8rRole }],
        });
      });
      return withEtag(reply, await member(workspaceId, request.params.userId));
    },
  );

  app.delete('/w/:ws/members/:userId', { config: ADMIN, schema: { params: MemberParams } }, async (request, reply) => {
    const version = ifMatch(request);
    const workspaceId = workspaceOf(request).id;
    await tx(pool, async client => {
      await lockMember(client, workspaceId, request.params.userId, version, null);
      await client.query('update workspace_member set deleted_at = now(), version = version + 1 where workspace_id = $1 and user_id = $2', [
        workspaceId,
        request.params.userId,
      ]);
      await record(client, request, { verb: 'deleted', entityKind: 'member', entityId: request.params.userId, entityVersion: version + 1 });
    });
    return reply.code(204).send();
  });

  // ---------- teams ----------
  app.get('/w/:ws/teams', { config: ANY, schema: { params: Ws } }, async request => {
    const { rows } = await pool.query<Row>(`${TEAM_SELECT} where t.workspace_id = $1 and t.deleted_at is null order by t.name, t.id`, [
      workspaceOf(request).id,
    ]);
    return { items: rows.map(renderTeam), nextCursor: null };
  });

  app.get('/w/:ws/teams/:id', { config: ANY, schema: { params: WsId } }, async (request, reply) =>
    withEtag(reply, await team(workspaceOf(request).id, request.params.id)),
  );

  app.post(
    '/w/:ws/teams',
    {
      config: ADMIN,
      schema: { params: Ws, body: Type.Object({ key: Type.String({ pattern: '^[a-z0-9_]{1,40}$' }), ...TeamFields }, { additionalProperties: false }) },
    },
    (request, reply) =>
      created(pool, request, reply, async () => {
        const workspace = workspaceOf(request);
        const id = await tx(pool, async client => {
          const row = await insertRow(client, 'team', { workspace_id: workspace.id, ...columnsOf(request.body) });
          await record(client, request, { verb: 'created', entityKind: 'team', entityId: String(row.id), entityVersion: 1 });
          return String(row.id);
        });
        return { body: await team(workspace.id, id), location: `/api/v1/w/${workspace.slug}/teams/${id}` };
      }),
  );

  app.patch(
    '/w/:ws/teams/:id',
    { config: ADMIN, schema: { params: WsId, body: Type.Partial(Type.Object(TeamFields), { additionalProperties: false }) } },
    async (request, reply) => {
      await change(pool, request, { table: 'team', kind: 'team', id: request.params.id, render: renderTeam, set: () => columnsOf(request.body) });
      return withEtag(reply, await team(workspaceOf(request).id, request.params.id));
    },
  );

  app.delete('/w/:ws/teams/:id', { config: ADMIN, schema: { params: WsId } }, async (request, reply) => {
    await remove(pool, request, { table: 'team', kind: 'team', id: request.params.id, render: renderTeam });
    return reply.code(204).send();
  });

  const TeamMember = Type.Object({ ws: Type.String(), id: Id, userId: Id });
  app.put('/w/:ws/teams/:id/members/:userId', { config: ADMIN, schema: { params: TeamMember } }, async (request, reply) => {
    const { id, userId } = request.params;
    await tx(pool, async client => {
      await team(workspaceOf(request).id, id);
      await member(workspaceOf(request).id, userId);
      const { rowCount } = await client.query(`insert into team_member (team_id, user_id, source) values ($1, $2, 'manual') on conflict do nothing`, [
        id,
        userId,
      ]);
      if (rowCount) {
        await client.query('update team set version = version + 1 where id = $1', [id]);
        await record(client, request, { verb: 'updated', entityKind: 'team', entityId: id, changes: [{ field: 'members', from: null, to: userId }] });
      }
    });
    return reply.code(204).send();
  });

  app.delete('/w/:ws/teams/:id/members/:userId', { config: ADMIN, schema: { params: TeamMember } }, async (request, reply) => {
    const { id, userId } = request.params;
    await tx(pool, async client => {
      await team(workspaceOf(request).id, id);
      const { rows } = await client.query<{ source: string }>('delete from team_member where team_id = $1 and user_id = $2 returning source', [id, userId]);
      if (rows[0]?.source === 'entra') {
        throw new ApiError(409, 'managed_by_entra', "This membership comes from the person's Entra app role. Change the role in Entra instead.");
      }
      if (rows[0]) {
        await client.query('update team set version = version + 1 where id = $1', [id]);
        await record(client, request, { verb: 'updated', entityKind: 'team', entityId: id, changes: [{ field: 'members', from: userId, to: null }] });
      }
    });
    return reply.code(204).send();
  });
  done();
}
