import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ContainerClient } from '@azure/storage-blob';
import type pg from 'pg';
import { migrate } from '../db/migrate.js';
import { APP_ROLE_PASSWORD, emptyDatabase, skipWithoutDatabase } from '../testing/database.js';
import { ApiError } from './problem.js';
import { discardFile, readFile, storeFile, UPLOAD_LIMIT } from './files.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZJisAAAAASUVORK5CYII=', 'base64');

class MemoryBlobs {
  readonly objects = new Map<string, Buffer>();
  readonly deleted: string[] = [];

  getBlockBlobClient(name: string) {
    return {
      uploadStream: async (stream: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(chunk));
        this.objects.set(name, Buffer.concat(chunks));
      },
      deleteIfExists: () => {
        this.deleted.push(name);
        this.objects.delete(name);
        return Promise.resolve({ succeeded: true });
      },
    };
  }

  getBlobClient(name: string) {
    return {
      download: () => Promise.resolve({ readableStreamBody: Readable.from(this.objects.get(name) ?? Buffer.alloc(0)) }),
    };
  }

  container(): ContainerClient {
    return this as unknown as ContainerClient;
  }
}

async function body(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function fixture(t: TestContext) {
  const database = await emptyDatabase(t);
  const owner = await database.connect();
  await migrate(owner, () => undefined);
  const workspace = await owner.query<{ id: string }>(`insert into workspace (slug, name) values ('files', 'Synthetic files') returning id`);
  const user = await owner.query<{ id: string }>(
    `insert into app_user (email, name, app_roles) values ('files@example.test', 'File Tester', '{Launch.Manager}') returning id`,
  );
  const db = await database.connect('lt_app', APP_ROLE_PASSWORD);
  return {
    db: db as unknown as pg.PoolClient,
    workspaceId: workspace.rows[0]?.id ?? '',
    userId: user.rows[0]?.id ?? '',
  };
}

test('storeFile sniffs, hashes and streams an attachment; read and discard use its opaque Blob name', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();

  const file = await storeFile(db, memory.container(), {
    workspaceId,
    uploadedBy: userId,
    name: '../evidence.png',
    data: Readable.from(PNG),
    area: 'attachments',
  });

  assert.equal(file.name, 'evidence.png');
  assert.equal(file.contentType, 'image/png');
  assert.equal(file.sizeBytes, PNG.length);
  assert.equal(file.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.match(String(file.blobName), new RegExp(`^attachments/${workspaceId}/[0-9a-f-]{36}$`));
  assert.deepEqual(memory.objects.get(String(file.blobName)), PNG);
  assert.deepEqual(await body(await readFile(memory.container(), file)), PNG);

  await discardFile(db, memory.container(), file);
  assert.equal(memory.objects.has(String(file.blobName)), false);
  const kept = await db.query<{ deleted_at: Date | null; version: number }>('select deleted_at, version from file where id = $1', [file.id]);
  const keptRow = kept.rows[0];
  assert.ok(keptRow);
  assert.ok(keptRow.deleted_at);
  assert.equal(keptRow.version, 2);
});

test('storeFile recognises the synthetic workbook by content and can restrict imports to xlsx', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();
  const workbook = readFileSync(fileURLToPath(new URL('../../../templates/launch-workbook/launch-workbook-template.xlsx', import.meta.url)));

  const file = await storeFile(db, memory.container(), {
    workspaceId,
    uploadedBy: userId,
    name: 'synthetic-launch.xlsx',
    data: Readable.from(workbook),
    area: 'imports',
    allow: ['xlsx'],
  });

  assert.equal(file.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(file.sizeBytes, workbook.length);
  assert.match(String(file.blobName), new RegExp(`^imports/${workspaceId}/`));
});

test('storeFile refuses unsupported content before writing a row or Blob', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();

  await assert.rejects(
    storeFile(db, memory.container(), {
      workspaceId,
      uploadedBy: userId,
      name: 'program.exe',
      data: Readable.from(Buffer.from('4d5a900003000000', 'hex')),
      area: 'attachments',
    }),
    (error: unknown) => error instanceof ApiError && error.status === 415 && error.code === 'unsupported_media_type',
  );
  assert.equal(memory.objects.size, 0);
  assert.equal(Number((await db.query<{ count: string }>('select count(*) as count from file')).rows[0]?.count ?? '0'), 0);
});

test('storeFile removes a partial Blob when the database insert fails', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();

  await assert.rejects(
    storeFile(db, memory.container(), {
      workspaceId,
      uploadedBy: userId,
      name: 'evidence.png',
      data: Readable.from(PNG),
      area: 'attachments',
      projectId: randomUUID(),
    }),
    (error: unknown) => (error as { code?: string }).code === '23503',
  );
  assert.equal(memory.objects.size, 0);
  assert.equal(memory.deleted.length, 1);
});

test('storeFile stops over 25 MiB and removes the partial Blob', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();
  const data = Readable.from(
    (function* () {
      yield PNG;
      const block = Buffer.alloc(1024 * 1024);
      for (let sent = 0; sent <= UPLOAD_LIMIT; sent += block.length) yield block;
    })(),
  );

  await assert.rejects(
    storeFile(db, memory.container(), { workspaceId, uploadedBy: userId, name: 'huge.png', data, area: 'attachments' }),
    (error: unknown) => error instanceof ApiError && error.status === 413 && error.code === 'payload_too_large',
  );
  assert.equal(memory.objects.size, 0);
  assert.equal(memory.deleted.length, 1);
});
