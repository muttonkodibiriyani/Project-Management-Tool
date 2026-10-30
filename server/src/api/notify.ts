import type { FastifyRequest } from 'fastify';
import type { Db } from '../db/tx.js';
import { workspaceOf } from './context.js';

export type NotificationType = 'mention' | 'assign' | 'comment' | 'due' | 'follow_up' | 'status' | 'import';

/** Puts a notification in each person's inbox, never the actor's own. `text` gets the actor's name in front. */
export async function notify(
  db: Db,
  request: FastifyRequest,
  userIds: (string | null | undefined)[],
  type: NotificationType,
  text: string,
  refs: { taskId?: string; commentId?: string } = {},
) {
  const workspace = workspaceOf(request);
  const to = [...new Set(userIds.filter((id): id is string => typeof id === 'string' && id !== workspace.actor.userId))];
  if (to.length === 0) return;
  await db.query(
    `insert into notification (workspace_id, user_id, type, actor_id, task_id, comment_id, text)
     select $1, u, $3, a.id, $5, $6, a.name || ' ' || $4 from unnest($2::uuid[]) u, app_user a where a.id = $7`,
    [workspace.id, to, type, text, refs.taskId ?? null, refs.commentId ?? null, workspace.actor.userId],
  );
}
