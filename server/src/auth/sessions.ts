import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import { SignInError } from './entra.js';
import type { AppRole } from './roles.js';

/** Sessions last 12 hours from sign-in, not sliding; roles and Entra teams are re-read at the next sign-in. */
export const SESSION_HOURS = 12;

/** Who signed in, as the ID token (or the test identity provider) says. */
export interface Identity {
  /** Entra object ID (`oid`). */
  oid: string;
  tenantId: string;
  email: string;
  name: string;
  roles: AppRole[];
}

export interface Visitor {
  userAgent: string | null;
  ip: string | null;
}

/**
 * Creates and ends sessions. The browser holds only a random token in an HttpOnly cookie and
 * `user_session` keeps its SHA-256, so a leaked table cannot be replayed as cookies. The API reads
 * sessions itself (cookie → hash → `user_session` → `app_user`).
 */
export interface SessionWriter {
  start(identity: Identity, visitor: Visitor): Promise<{ token: string; expiresAt: Date }>;
  end(token: string): Promise<void>;
}

export const hashToken = (token: string): Buffer => createHash('sha256').update(token).digest();

/** A pg.Pool, or anything that hands out a client to release. */
export interface Database {
  connect(): Promise<pg.PoolClient>;
}

const UNIQUE_VIOLATION = '23505';

export function postgresSessions(database: Database): SessionWriter {
  return {
    async start(identity, visitor) {
      const client = await database.connect();
      try {
        await client.query('begin');
        const userId = await signInUser(client, identity);
        await syncEntraTeams(client, userId, identity.roles);
        const token = randomBytes(32).toString('base64url');
        const { rows } = await client.query<{ expires_at: Date }>(
          `insert into user_session (user_id, token_hash, user_agent, ip, expires_at)
           values ($1, $2, $3, $4, now() + make_interval(hours => $5)) returning expires_at`,
          [userId, hashToken(token), visitor.userAgent?.slice(0, 512) ?? null, visitor.ip, SESSION_HOURS],
        );
        await client.query('commit');
        return { token, expiresAt: (rows[0] as { expires_at: Date }).expires_at };
      } catch (error) {
        await client.query('rollback');
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new SignInError('account_conflict', `another Launch Tracker user already has the e-mail of user ${identity.oid}`);
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async end(token) {
      const client = await database.connect();
      try {
        await client.query('update user_session set revoked_at = now() where token_hash = $1 and revoked_at is null', [hashToken(token)]);
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Finds the user by Entra object ID, else claims a pending gr8r invite with the same e-mail, else
 * adds them. The name is set only then, so a name changed in the app's profile is kept.
 */
async function signInUser(client: pg.PoolClient, identity: Identity): Promise<string> {
  const { oid, tenantId, email, name, roles } = identity;
  const found =
    (
      await client.query<{ id: string; status: string }>(
        `update app_user set tenant_id = $2, email = $3, app_roles = $4, last_seen_at = now()
         where entra_oid = $1 returning id, status`,
        [oid, tenantId, email, roles],
      )
    ).rows[0] ??
    (
      await client.query<{ id: string; status: string }>(
        `update app_user set entra_oid = $1, tenant_id = $2, name = $4, app_roles = $5, last_seen_at = now(),
                status = case when status = 'invited' then 'active' else status end
         where email = $3 and entra_oid is null returning id, status`,
        [oid, tenantId, email, name, roles],
      )
    ).rows[0] ??
    (
      await client.query<{ id: string; status: string }>(
        `insert into app_user (entra_oid, tenant_id, email, name, app_roles, last_seen_at)
         values ($1, $2, $3, $4, $5, now()) returning id, status`,
        [oid, tenantId, email, name, roles],
      )
    ).rows[0];
  if (!found) throw new Error(`app_user returned no row for user ${oid}`);
  if (found.status === 'disabled') throw new SignInError('account_disabled', `user ${oid} is disabled in Launch Tracker`);
  return found.id;
}

/**
 * Teams with `app_role` set take their members from the role at each sign-in: the user joins every
 * such team whose role they hold and leaves those whose role they lost. Manual memberships stay.
 */
async function syncEntraTeams(client: pg.PoolClient, userId: string, roles: readonly AppRole[]) {
  await client.query(
    `delete from team_member m using team t
     where m.team_id = t.id and m.user_id = $1 and m.source = 'entra'
       and (t.deleted_at is not null or t.app_role is null or not t.app_role = any($2::text[]))`,
    [userId, roles],
  );
  await client.query(
    `insert into team_member (team_id, user_id, source)
     select id, $1, 'entra' from team where deleted_at is null and app_role = any($2::text[])
     on conflict (team_id, user_id) do nothing`,
    [userId, roles],
  );
}
