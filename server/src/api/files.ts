import { createHash, randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ContainerClient } from '@azure/storage-blob';
import { fileTypeFromBuffer } from 'file-type';
import type pg from 'pg';
import { afterCommit, afterRollback, type Db } from '../db/tx.js';
import { toApi, type Row } from './http.js';
import { ApiError, invalid } from './problem.js';
import { insertRow } from './rows.js';

export const UPLOAD_LIMIT = 25 * 1024 * 1024;
const SNIFF_BYTES = 64 * 1024;

const TYPES = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  txt: 'text/plain; charset=utf-8',
} as const;
type AllowedType = keyof typeof TYPES;
const DEFAULT_ALLOW = Object.keys(TYPES) as AllowedType[];

const DETECTED_TYPES: Record<string, AllowedType> = {
  pdf: 'pdf',
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  gif: 'gif',
  webp: 'webp',
  xlsx: 'xlsx',
  docx: 'docx',
  pptx: 'pptx',
  zip: 'zip',
};

export interface StoreFileInput {
  workspaceId: string;
  uploadedBy: string;
  name: string;
  data: NodeJS.ReadableStream;
  area: 'attachments' | 'imports';
  projectId?: string | null;
  taskId?: string | null;
  commentId?: string | null;
  allow?: readonly string[];
}

interface Inspected {
  contentType: string;
  stream: Readable;
}

const unsupported = (allow: readonly string[]) =>
  new ApiError(415, 'unsupported_media_type', `This file's content is not an allowed type. Upload ${allow.join(', ')}.`);

function safeName(name: string): string {
  const cleaned = basename(name.replaceAll('\0', '')).trim();
  if (!cleaned) {
    throw new ApiError(422, 'validation_failed', 'The uploaded file needs a name.', {
      errors: [{ path: 'file.name', code: 'required', message: 'Choose a named file.' }],
    });
  }
  if (cleaned.length > 255) {
    throw new ApiError(422, 'validation_failed', 'The uploaded file name is too long.', {
      errors: [{ path: 'file.name', code: 'too_long', message: 'Use a file name no longer than 255 characters.' }],
    });
  }
  return cleaned;
}

function isText(sample: Buffer): boolean {
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
  } catch {
    return false;
  }
  let controls = 0;
  for (const byte of sample) if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) controls += 1;
  return sample.length === 0 || controls / sample.length < 0.01;
}

async function inspect(data: NodeJS.ReadableStream, name: string, allow: readonly string[]): Promise<Inspected> {
  const bounded = async function* (source: AsyncIterable<Uint8Array | string>) {
    for await (const value of source) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      for (let start = 0; start < chunk.length; start += SNIFF_BYTES) yield chunk.subarray(start, start + SNIFF_BYTES);
    }
  };
  const iterator = bounded(data as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();

  const prefetched: Buffer[] = [];
  let remainder: Buffer | undefined;
  const sampleParts: Buffer[] = [];
  let sampled = 0;
  while (sampled < SNIFF_BYTES) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    const wanted = Math.min(chunk.length, SNIFF_BYTES - sampled);
    const samplePart = chunk.subarray(0, wanted);
    prefetched.push(samplePart);
    sampleParts.push(samplePart);
    sampled += wanted;
    if (wanted < chunk.length) remainder = chunk.subarray(wanted);
  }
  const sample = Buffer.concat(sampleParts, sampled);
  const detected = await fileTypeFromBuffer(sample, { maxBufferSize: SNIFF_BYTES });
  let kind = detected ? DETECTED_TYPES[detected.ext] : undefined;
  if (!kind && isText(sample)) kind = extname(name).toLowerCase() === '.csv' || (allow.length === 1 && allow[0] === 'csv') ? 'csv' : 'txt';
  if (!kind || !allow.includes(kind)) throw unsupported(allow);

  const stream = Readable.from(
    (async function* () {
      yield* prefetched;
      if (remainder) yield remainder;
      for await (const value of { [Symbol.asyncIterator]: () => iterator }) yield value;
    })(),
  );
  return { contentType: TYPES[kind], stream };
}

async function validateParents(db: Db, input: StoreFileInput): Promise<void> {
  const check = async (table: 'project' | 'task' | 'comment', id: string | null | undefined, path: string) => {
    if (!id) return undefined;
    const { rows } = await db.query<{ workspace_id: string; project_id?: string; task_id?: string }>(
      `select workspace_id,
              ${table === 'task' ? 'project_id' : 'null::uuid as project_id'},
              ${table === 'comment' ? 'task_id' : 'null::uuid as task_id'}
         from ${table} where id = $1 and deleted_at is null`,
      [id],
    );
    const row = rows[0];
    if (!row || row.workspace_id !== input.workspaceId) {
      throw invalid([{ path, code: 'unknown_ref', message: `${path} is not a live row in this workspace.` }]);
    }
    return row;
  };
  const project = await check('project', input.projectId, 'projectId');
  const task = await check('task', input.taskId, 'taskId');
  const comment = await check('comment', input.commentId, 'commentId');
  if (project && task?.project_id !== input.projectId) {
    throw invalid([{ path: 'taskId', code: 'unknown_ref', message: 'taskId does not belong to projectId.' }]);
  }
  if (task && comment?.task_id !== input.taskId) {
    throw invalid([{ path: 'commentId', code: 'unknown_ref', message: 'commentId does not belong to taskId.' }]);
  }
}

function blobCleanup(workspaceId: string, path: string, block: ReturnType<ContainerClient['getBlockBlobClient']>) {
  return {
    kind: 'blob' as const,
    workspaceId,
    key: path,
    run: async (pool: pg.Pool) => {
      // COMMIT can fail ambiguously after PostgreSQL accepted it. Never erase a Blob whose live row did commit.
      const { rows } = await pool.query<{ found: boolean }>(
        'select true as found from file where workspace_id = $1 and blob_name = $2 and deleted_at is null',
        [workspaceId, path],
      );
      if (!rows[0]?.found) await block.deleteIfExists({ deleteSnapshots: 'include' });
      await pool.query('delete from deferred_cleanup where kind = $1 and workspace_id = $2 and key = $3', ['blob', workspaceId, path]);
    },
  };
}

function finalizeIntent(workspaceId: string, path: string) {
  return {
    kind: 'blob' as const,
    workspaceId,
    key: path,
    run: async (pool: pg.Pool) => {
      await pool.query('delete from deferred_cleanup where kind = $1 and workspace_id = $2 and key = $3', ['blob', workspaceId, path]);
    },
  };
}

function blobName(file: Row): string {
  const name = file.blob_name ?? file.blobName;
  if (typeof name !== 'string' || !name) throw new Error('The file row has no blob name');
  return name;
}

function fileWorkspace(file: Row, path: string): string {
  const workspaceId = file.workspace_id ?? file.workspaceId;
  if (typeof workspaceId === 'string' && workspaceId) return workspaceId;
  const fromPath = path.split('/')[1];
  if (!fromPath || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(fromPath)) {
    throw new Error('The file row has no workspace id');
  }
  return fromPath;
}

async function createIntent(pool: pg.Pool, workspaceId: string, path: string): Promise<void> {
  // Twenty-four hours is deliberately much longer than a 25 MiB request. It prevents the hourly
  // worker from racing a slow live upload, while still bounding how long a crash orphan can remain.
  await pool.query(
    `insert into deferred_cleanup (kind, workspace_id, key, available_at)
     values ('blob', $1, $2, now() + interval '24 hours')`,
    [workspaceId, path],
  );
}

async function makeIntentReady(pool: pg.Pool, workspaceId: string, path: string): Promise<void> {
  const updated = await pool.query(
    `update deferred_cleanup
        set attempts = attempts + 1, available_at = now(), last_attempt_at = now(), lease_token = null
      where kind = 'blob' and workspace_id = $1 and key = $2`,
    [workspaceId, path],
  );
  if (updated.rowCount !== 1) throw new Error('The durable Blob cleanup intent vanished before cleanup completed.');
}

export interface StagedFile {
  readonly blobName: string;
  /** Inserts the file row and registers commit/rollback finalization in the caller's tx(pool, ...). */
  attach(db: pg.PoolClient): Promise<Row>;
}

/**
 * Sniffs an upload, commits a durable cleanup intent, then streams it to Blob without holding a
 * caller transaction. The returned handle must be attached inside tx(pool, ...), together with
 * the domain rows that reference it. A crash in any gap is repaired by the cleanup worker.
 */
export async function storeFile(pool: pg.Pool, blobs: ContainerClient, input: StoreFileInput): Promise<StagedFile> {
  const name = safeName(input.name);
  const allow = input.allow ?? DEFAULT_ALLOW;
  const unknown = allow.filter(type => !(type in TYPES));
  if (unknown.length) throw new Error(`Unknown allowed upload type: ${unknown.join(', ')}`);
  // This avoids an unnecessary upload for an already-invalid parent. attach() repeats the checks
  // in the write transaction so a concurrent move/delete cannot cross a workspace boundary.
  await validateParents(pool, input);
  const { contentType, stream } = await inspect(input.data, name, allow);
  const id = randomUUID();
  const path = `${input.area}/${input.workspaceId}/${id}`;
  const block = blobs.getBlockBlobClient(path);
  await createIntent(pool, input.workspaceId, path);
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > UPLOAD_LIMIT) {
        callback(new ApiError(413, 'payload_too_large', 'The uploaded file is over 25 MiB. Choose a smaller file.'));
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await block.uploadStream(stream.pipe(meter), 4 * 1024 * 1024, 2, {
      blobHTTPHeaders: { blobContentType: contentType },
    });
  } catch (uploadError) {
    try {
      await blobCleanup(input.workspaceId, path, block).run(pool);
    } catch (cleanupError) {
      try {
        await makeIntentReady(pool, input.workspaceId, path);
      } catch (queueError) {
        throw new AggregateError([uploadError, cleanupError, queueError], 'The upload failed, and neither its Blob cleanup nor durable retry could finish.');
      }
      throw new AggregateError([uploadError, cleanupError], 'The upload failed and its Blob cleanup was queued for retry.');
    }
    throw uploadError;
  }
  const sha256 = hash.digest('hex');
  let attached = false;
  return {
    blobName: path,
    attach: async db => {
      if (attached) throw new Error('This staged file has already been attached.');
      attached = true;
      afterRollback(db, blobCleanup(input.workspaceId, path, block));
      afterCommit(db, finalizeIntent(input.workspaceId, path));
      await validateParents(db, input);
      const row = await insertRow(db, 'file', {
        id,
        workspace_id: input.workspaceId,
        project_id: input.projectId ?? null,
        task_id: input.taskId ?? null,
        comment_id: input.commentId ?? null,
        name,
        content_type: contentType,
        size_bytes: size,
        sha256,
        blob_container: input.area,
        blob_name: path,
        uploaded_by: input.uploadedBy,
      });
      return toApi(row);
    },
  };
}

export async function readFile(blobs: ContainerClient, file: Row): Promise<NodeJS.ReadableStream> {
  const response = await blobs.getBlobClient(blobName(file)).download();
  if (!response.readableStreamBody) throw new Error(`Blob ${blobName(file)} returned no content stream`);
  return response.readableStreamBody;
}

/** Soft-deletes the database row; tx removes its Blob only after COMMIT and durably retries failures. */
export async function discardFile(db: pg.PoolClient, blobs: ContainerClient, file: Row): Promise<void> {
  const id = file.id;
  if (typeof id !== 'string' || !id) throw new Error('The file row has no id');
  await db.query(`update file set deleted_at = now(), version = version + 1 where id = $1 and deleted_at is null`, [id]);
  const path = blobName(file);
  afterCommit(db, blobCleanup(fileWorkspace(file, path), path, blobs.getBlockBlobClient(path)));
}
