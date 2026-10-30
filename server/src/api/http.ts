import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './problem.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Row = Record<string, unknown>;

const HIDDEN = new Set(['workspace_id', 'change_seq', 'deleted_at', 'token_hash', 'name_norm', 'next_task_no']);

/** A database row as the API sends it: camelCase keys, plumbing columns left out. */
export function toApi(row: Row): Row {
  const out: Row = {};
  for (const [column, value] of Object.entries(row)) {
    if (!HIDDEN.has(column)) out[column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())] = value;
  }
  return out;
}

/** The row without these keys. */
export const omit = (row: Row, ...keys: string[]): Row => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)));

export const toColumn = (field: string) => field.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);

/** The version the client edited, from `If-Match: "7"`. Missing → 428, so nobody overwrites blind. */
export function ifMatch(request: FastifyRequest): number {
  const header = request.headers['if-match'];
  if (header === undefined) {
    throw new ApiError(428, 'version_required', 'Send If-Match with the version you edited, e.g. If-Match: "3"; read the row first if you do not have it.');
  }
  const match = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim());
  if (!match?.[1]) throw new ApiError(400, 'bad_request', `If-Match must be a row version such as "3"; got ${JSON.stringify(header)}.`);
  return Number(match[1]);
}

export function withEtag<T extends Row>(reply: FastifyReply, row: T): T {
  reply.header('etag', `"${String(row.version)}"`);
  return row;
}

/** RFC 7396: keys present are set, null removes the key, keys absent are kept. */
export function mergePatch(target: Record<string, Json>, patch: Record<string, Json>): Record<string, Json> {
  const removed = new Set(Object.keys(patch).filter(key => patch[key] === null));
  return Object.fromEntries([...Object.entries(target), ...Object.entries(patch)].filter(([key]) => !removed.has(key)));
}

/** Where the next page starts (a keyset or an offset, per endpoint). Opaque to the client. */
export function encodeCursor(after: Json): string {
  return Buffer.from(JSON.stringify(after)).toString('base64url');
}

const badCursor = () => new ApiError(400, 'bad_cursor', 'The page cursor is not one this API gave out. Start again from the first page.');

/** The cursor's content, if `valid` accepts it; anything else is 400 bad_cursor. */
export function decodeCursor<T extends Json>(cursor: string | undefined, valid: (value: unknown) => value is T): T | undefined {
  if (cursor === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw badCursor();
  }
  if (!valid(value)) throw badCursor();
  return value;
}

export type Keyset = [string | number, string];
export const isKeyset = (value: unknown): value is Keyset =>
  Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number') && typeof value[1] === 'string';
export const isOffset = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

/** One page from rows fetched with limit + 1, so the next page is known without a count. */
export function page<T extends Row>(rows: T[], limit: number, next: (last: T) => Json, map: (row: T) => unknown = toApi) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(map), nextCursor: rows.length > limit && last ? encodeCursor(next(last)) : null };
}

/** An ILIKE pattern for "contains", with the user's own % _ \ taken literally. */
export const contains = (text: string) => `%${text.replace(/[\\%_]/g, c => `\\${c}`)}%`;
