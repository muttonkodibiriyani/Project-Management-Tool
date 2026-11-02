import { createHash, randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ContainerClient } from '@azure/storage-blob';
import { fileTypeFromBuffer } from 'file-type';
import type pg from 'pg';
import { afterCommit, afterRollback } from '../db/tx.js';
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
  const iterator = (data as AsyncIterable<Uint8Array | string>)[Symbol.asyncIterator]();

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
      if (remainder) {
        for (let start = 0; start < remainder.length; start += SNIFF_BYTES) yield remainder.subarray(start, start + SNIFF_BYTES);
      }
      for await (const value of { [Symbol.asyncIterator]: () => iterator }) yield Buffer.isBuffer(value) ? value : Buffer.from(value);
    })(),
  );
  return { contentType: TYPES[kind], stream };
}

async function validateParents(db: pg.PoolClient, input: StoreFileInput): Promise<void> {
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

function blobCleanup(path: string, block: ReturnType<ContainerClient['getBlockBlobClient']>) {
  return {
    kind: 'blob' as const,
    key: path,
    run: async (pool: pg.Pool) => {
      // COMMIT can fail ambiguously after PostgreSQL accepted it. Never erase a Blob whose live row did commit.
      const { rows } = await pool.query<{ deleted_at: Date | null }>('select deleted_at from file where blob_name = $1', [path]);
      if (rows[0]?.deleted_at === null) return;
      await block.deleteIfExists({ deleteSnapshots: 'include' });
    },
  };
}

function blobName(file: Row): string {
  const name = file.blob_name ?? file.blobName;
  if (typeof name !== 'string' || !name) throw new Error('The file row has no blob name');
  return name;
}

/**
 * Sniffs and streams one upload to Blob, then inserts its file row using the caller's
 * transaction. A failed upload or insert deletes the partial blob before the error escapes.
 */
export async function storeFile(db: pg.PoolClient, blobs: ContainerClient, input: StoreFileInput): Promise<Row> {
  const name = safeName(input.name);
  const allow = input.allow ?? DEFAULT_ALLOW;
  const unknown = allow.filter(type => !(type in TYPES));
  if (unknown.length) throw new Error(`Unknown allowed upload type: ${unknown.join(', ')}`);
  await validateParents(db, input);
  const { contentType, stream } = await inspect(input.data, name, allow);
  const id = randomUUID();
  const path = `${input.area}/${input.workspaceId}/${id}`;
  const block = blobs.getBlockBlobClient(path);
  afterRollback(db, blobCleanup(path, block));
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

  await block.uploadStream(stream.pipe(meter), 4 * 1024 * 1024, 2, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
  const row = await insertRow(db, 'file', {
    id,
    workspace_id: input.workspaceId,
    project_id: input.projectId ?? null,
    task_id: input.taskId ?? null,
    comment_id: input.commentId ?? null,
    name,
    content_type: contentType,
    size_bytes: size,
    sha256: hash.digest('hex'),
    blob_container: input.area,
    blob_name: path,
    uploaded_by: input.uploadedBy,
  });
  return toApi(row);
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
  afterCommit(db, blobCleanup(path, blobs.getBlockBlobClient(path)));
}
