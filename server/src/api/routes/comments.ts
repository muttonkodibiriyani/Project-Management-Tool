import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { isAdmin } from '../../access/policy.js';
import { tx, type Db } from '../../db/tx.js';
import { workspaceOf } from '../context.js';
import { decodeCursor, isKeyset, omit, page, toApi, withEtag, type Row } from '../http.js';
import { notify } from '../notify.js';
import type { ApiOptions } from '../plugin.js';
import { forbidden, invalid, notFound } from '../problem.js';
import { change, created, insertRow, record, remove } from '../rows.js';
import { sanitize } from '../sanitize.js';
import { Id, Limit, WsId } from '../schemas.js';
import { VISIBLE } from './projects.js';

const Body = Type.String({ minLength: 1, maxLength: 20000 });
const MentionIds = Type.Array(Id, { maxItems: 50, uniqueItems: true });

/** `$1` user, `$2` admin, `$3` workspace; the comment's task must be one the caller may see. */
const COMMENT_SELECT = `
  select c.*, t.project_id,
         array(select m.user_id from comment_mention m where m.comment_id = c.id order by m.user_id) as mention_ids,
         array(select f.id from file f where f.comment_id = c.id and f.deleted_at is null order by f.created_at, f.id) as file_ids,
         coalesce((select json_agg(json_build_object('emoji', r.emoji, 'userIds', r.user_ids) order by r.first)
                     from (select emoji, array_agg(user_id order by created_at) as user_ids, min(created_at) as first
                             from comment_reaction where comment_id = c.id group by emoji) r), '[]') as reactions
    from comment c join task t on t.id = c.task_id and t.deleted_at is null join project p on p.id = t.project_id and p.deleted_at is null
   where c.workspace_id = $3 and c.deleted_at is null and ${VISIBLE}`;

const renderComment = (row: Row) => omit(toApi(row), 'projectId');

export function comments(plain: FastifyInstance, { pool }: ApiOptions, done: () => void) {
  const app = plain.withTypeProvider<TypeBoxTypeProvider>();

  async function readComments(db: Db, request: FastifyRequest, where: string, params: unknown[]) {
    const workspace = workspaceOf(request);
    const { rows } = await db.query<Row>(`${COMMENT_SELECT} and ${where}`, [workspace.actor.userId, isAdmin(workspace.actor), workspace.id, ...params]);
    return rows;
  }

  async function readComment(db: Db, request: FastifyRequest, id: string) {
    const row = (await readComments(db, request, 'c.id = $4', [id]))[0];
    if (!row) throw notFound('This comment');
    return row;
  }

  /** A task the caller may see: its id and project. */
  async function visibleTask(request: FastifyRequest, id: string) {
    const workspace = workspaceOf(request);
    const { rows } = await pool.query<{ id: string; project_id: string; key: string }>(
      `select t.id, t.project_id, t.key from task t join project p on p.id = t.project_id and p.deleted_at is null
        where t.id = $4 and t.workspace_id = $3 and t.deleted_at is null and ${VISIBLE}`,
      [workspace.actor.userId, isAdmin(workspace.actor), workspace.id, id],
    );
    if (!rows[0]) throw notFound('This task');
    return rows[0];
  }

  /** Replaces the comment's mentions; every one must be a member. Returns who was newly mentioned. */
  async function setMentions(client: pg.PoolClient, workspaceId: string, commentId: string, mentionIds: string[]) {
    const members = await client.query('select 1 from workspace_member where workspace_id = $1 and user_id = any($2) and deleted_at is null', [
      workspaceId,
      mentionIds,
    ]);
    if (members.rowCount !== mentionIds.length)
      throw invalid([{ path: 'mentionIds', code: 'unknown_ref', message: 'Everyone you mention must be a member of this workspace.' }]);
    const before = await client.query<{ user_id: string }>('delete from comment_mention where comment_id = $1 returning user_id', [commentId]);
    await client.query('insert into comment_mention (comment_id, user_id) select $1, unnest($2::uuid[])', [commentId, mentionIds]);
    return mentionIds.filter(id => !before.rows.some(row => row.user_id === id));
  }

  app.get(
    '/tasks/:id/comments',
    {
      config: { access: 'any' },
      schema: {
        params: WsId,
        querystring: Type.Object({ limit: Limit(100), cursor: Type.Optional(Type.String({ maxLength: 200 })) }, { additionalProperties: false }),
      },
    },
    async request => {
      const { limit, cursor } = request.query;
      await visibleTask(request, request.params.id);
      const after = decodeCursor(cursor, isKeyset);
      const rows = await readComments(
        pool,
        request,
        `c.task_id = $4 and ($5::timestamptz is null or (c.created_at, c.id) > ($5, $6::uuid)) order by c.created_at, c.id limit $7`,
        [request.params.id, after?.[0] ?? null, after?.[1] ?? null, limit + 1],
      );
      return page(rows, limit, last => [(last.created_at as Date).toISOString(), String(last.id)], renderComment);
    },
  );

  app.post(
    '/tasks/:id/comments',
    {
      config: { access: 'editor' },
      schema: {
        params: WsId,
        body: Type.Object(
          { body: Body, mentionIds: Type.Optional(MentionIds), fileIds: Type.Optional(Type.Array(Id, { maxItems: 20, uniqueItems: true })) },
          { additionalProperties: false },
        ),
      },
    },
    (request, reply) =>
      created(pool, request, reply, async () => {
        const workspace = workspaceOf(request);
        const task = await visibleTask(request, request.params.id);
        const { mentionIds = [], fileIds = [] } = request.body;
        const body = sanitize(request.body.body);
        if (body.trim() === '') throw invalid([{ path: 'body', code: 'required', message: 'The comment is empty once unsafe markup is removed.' }]);
        const id = await tx(pool, async client => {
          const comment = await insertRow(client, 'comment', { workspace_id: workspace.id, task_id: task.id, author_id: workspace.actor.userId, body });
          const commentId = String(comment.id);
          const mentioned = await setMentions(client, workspace.id, commentId, mentionIds);
          if (fileIds.length > 0) {
            const files = await client.query('update file set comment_id = $1 where id = any($2) and task_id = $3 and deleted_at is null', [
              commentId,
              fileIds,
              task.id,
            ]);
            if (files.rowCount !== fileIds.length)
              throw invalid([{ path: 'fileIds', code: 'unknown_ref', message: 'Every file must be attached to this task first.' }]);
          }
          await record(client, request, {
            verb: 'commented',
            entityKind: 'comment',
            entityId: commentId,
            entityVersion: 1,
            projectId: task.project_id,
            taskId: task.id,
          });
          await notify(client, request, mentioned, 'mention', `mentioned you on ${task.key}`, { taskId: task.id, commentId });
          return commentId;
        });
        return { body: renderComment(await readComment(pool, request, id)), location: `/api/v1/w/${workspace.slug}/comments/${id}` };
      }),
  );

  app.patch(
    '/comments/:id',
    {
      config: { access: 'editor' },
      schema: { params: WsId, body: Type.Partial(Type.Object({ body: Body, mentionIds: MentionIds }), { additionalProperties: false, minProperties: 1 }) },
    },
    async (request, reply) => {
      const workspace = workspaceOf(request);
      const current = await readComment(pool, request, request.params.id);
      const context = () => ({ projectId: String(current.project_id), taskId: String(current.task_id) });
      await change(pool, request, {
        table: 'comment',
        kind: 'comment',
        id: request.params.id,
        render: renderComment,
        context,
        set: async (before, client) => {
          if (before.author_id !== workspace.actor.userId) throw forbidden('Only the author edits a comment.');
          const set: Row = { edited_at: new Date() };
          if (request.body.body !== undefined) set.body = sanitize(request.body.body);
          if (request.body.mentionIds) {
            const mentioned = await setMentions(client, workspace.id, request.params.id, request.body.mentionIds);
            await notify(client, request, mentioned, 'mention', 'mentioned you in a comment', { taskId: String(before.task_id), commentId: request.params.id });
          }
          return set;
        },
      });
      return withEtag(reply, renderComment(await readComment(pool, request, request.params.id)));
    },
  );

  app.delete('/comments/:id', { config: { access: 'editor' }, schema: { params: WsId } }, async (request, reply) => {
    const actor = workspaceOf(request).actor;
    const current = await readComment(pool, request, request.params.id);
    await remove(pool, request, {
      table: 'comment',
      kind: 'comment',
      id: request.params.id,
      render: renderComment,
      context: () => ({ projectId: String(current.project_id), taskId: String(current.task_id) }),
      check: row => {
        if (row.author_id !== actor.userId && !isAdmin(actor)) throw forbidden('Only the author or an admin deletes a comment.');
      },
    });
    return reply.code(204).send();
  });

  const ReactionParams = Type.Object({ ws: Type.String(), id: Id, emoji: Type.String({ minLength: 1, maxLength: 16 }) });

  app.put('/comments/:id/reactions/:emoji', { config: { access: 'editor' }, schema: { params: ReactionParams } }, async (request, reply) => {
    await readComment(pool, request, request.params.id);
    await pool.query('insert into comment_reaction (comment_id, user_id, emoji) values ($1, $2, $3) on conflict do nothing', [
      request.params.id,
      workspaceOf(request).actor.userId,
      request.params.emoji,
    ]);
    return reply.code(204).send();
  });

  app.delete('/comments/:id/reactions/:emoji', { config: { access: 'editor' }, schema: { params: ReactionParams } }, async (request, reply) => {
    await readComment(pool, request, request.params.id);
    await pool.query('delete from comment_reaction where comment_id = $1 and user_id = $2 and emoji = $3', [
      request.params.id,
      workspaceOf(request).actor.userId,
      request.params.emoji,
    ]);
    return reply.code(204).send();
  });
  done();
}
