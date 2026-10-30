import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Access, Actor, WorkspaceSettings } from '../access/policy.js';
import { ApiError, notFound } from './problem.js';

export const SESSION_COOKIE = '__Host-lt_session';

export interface Caller {
  userId: string;
  sessionId: string;
  sessionExpiresAt: Date;
  roles: string[];
}

export interface Workspace {
  id: string;
  slug: string;
  settings: WorkspaceSettings;
  /** The caller in this workspace: roles plus the keys of their teams here. */
  actor: Actor;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    caller?: Caller;
    workspace?: Workspace;
  }
}

/** The signed-in caller, from the session cookie set by /auth/callback. Sign-in creates sessions; this only reads them. */
export async function loadCaller(pool: pg.Pool, token: string | undefined): Promise<Caller> {
  if (!token) throw new ApiError(401, 'unauthenticated', 'You are not signed in. Sign in at /auth/login and try again.');
  const hash = createHash('sha256').update(token).digest();
  const { rows } = await pool.query<{
    id: string;
    user_id: string;
    expires_at: Date;
    ended: boolean;
    stale: boolean;
    app_roles: string[];
  }>(
    `select s.id, s.user_id, s.expires_at, s.revoked_at is not null or s.expires_at <= now() or u.status <> 'active' as ended,
            s.last_seen_at < now() - interval '1 minute' as stale, u.app_roles
       from user_session s join app_user u on u.id = s.user_id
      where s.token_hash = $1`,
    [hash],
  );
  const session = rows[0];
  if (!session) throw new ApiError(401, 'unauthenticated', 'You are not signed in. Sign in at /auth/login and try again.');
  if (session.ended) throw new ApiError(401, 'session_expired', 'Your session has ended. Sign in again at /auth/login.');
  if (session.stale) {
    await pool.query('update user_session set last_seen_at = now() where id = $1', [session.id]);
    await pool.query('update app_user set last_seen_at = now() where id = $1', [session.user_id]);
  }
  return { userId: session.user_id, sessionId: session.id, sessionExpiresAt: session.expires_at, roles: session.app_roles };
}

/** The workspace named by the slug, if the caller is a member of it; otherwise 404, so other workspaces cannot be discovered. */
export async function loadWorkspace(pool: pg.Pool, slug: string, caller: Caller): Promise<Workspace> {
  const { rows } = await pool.query<{ id: string; slug: string; settings: WorkspaceSettings; teams: string[] }>(
    `select w.id, w.slug, w.settings,
            array(select t.key from team_member tm join team t on t.id = tm.team_id
                   where tm.user_id = $2 and t.workspace_id = w.id and t.deleted_at is null order by t.key) as teams
       from workspace w join workspace_member m on m.workspace_id = w.id and m.user_id = $2 and m.deleted_at is null
      where w.slug = $1`,
    [slug, caller.userId],
  );
  const row = rows[0];
  if (!row) throw notFound(`Workspace ${slug}`);
  return { id: row.id, slug: row.slug, settings: row.settings, actor: { userId: caller.userId, roles: caller.roles, teams: row.teams } };
}

/** For handlers: the values the plugin's hooks guarantee on every /api/v1 route. */
export function callerOf(request: FastifyRequest): Caller {
  if (!request.caller) throw new Error(`${request.url} ran without a caller; the /api/v1 hooks did not run`);
  return request.caller;
}

export function workspaceOf(request: FastifyRequest): Workspace {
  if (!request.workspace) throw new Error(`${request.url} ran without a workspace; register it under /w/:ws`);
  return request.workspace;
}
