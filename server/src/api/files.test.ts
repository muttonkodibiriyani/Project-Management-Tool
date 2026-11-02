import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import pg from 'pg';
import { migrate } from '../db/migrate.js';
import { retryDeferredCleanups, tx } from '../db/tx.js';
import { APP_ROLE_PASSWORD, emptyDatabase, skipWithoutDatabase } from '../testing/database.js';
import { ApiError } from './problem.js';
import { discardFile, readFile, storeFile, UPLOAD_LIMIT } from './files.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZJisAAAAASUVORK5CYII=', 'base64');

class MemoryBlobs {
  readonly objects = new Map<string, Buffer>();
  readonly deleted: string[] = [];
  maxChunk = 0;
  failDeletes = 0;

  getBlockBlobClient(name: string) {
    return {
      uploadStream: async (stream: Readable) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream as AsyncIterable<Uint8Array | string>) {
          const value = Buffer.from(chunk);
          this.maxChunk = Math.max(this.maxChunk, value.length);
          chunks.push(value);
        }
        this.objects.set(name, Buffer.concat(chunks));
      },
      deleteIfExists: () => {
        if (this.failDeletes > 0) {
          this.failDeletes -= 1;
          return Promise.reject(new Error('synthetic Blob deletion failure'));
        }
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
  const closing: (() => Promise<void>)[] = [];
  t.after(async () => {
    for (const close of closing) await close();
  });
  const database = await emptyDatabase(t);
  const owner = await database.connect();
  await migrate(owner, () => undefined);
  const workspace = await owner.query<{ id: string }>(`insert into workspace (slug, name) values ('files', 'Synthetic files') returning id`);
  const user = await owner.query<{ id: string }>(
    `insert into app_user (email, name, app_roles) values ('files@example.test', 'File Tester', '{Launch.Manager}') returning id`,
  );
  const db = await database.connect('lt_app', APP_ROLE_PASSWORD);
  const current = await owner.query<{ name: string }>('select current_database() as name');
  const url = new URL(process.env.TEST_DATABASE_URL ?? '');
  url.pathname = `/${current.rows[0]?.name ?? ''}`;
  url.username = 'lt_app';
  url.password = APP_ROLE_PASSWORD;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  closing.push(() => pool.end());
  return {
    db: db as unknown as pg.PoolClient,
    owner,
    pool,
    workspaceId: workspace.rows[0]?.id ?? '',
    userId: user.rows[0]?.id ?? '',
  };
}

test('storeFile sniffs, hashes and streams an attachment; read and discard use its opaque Blob name', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();

  const file = await tx(pool, client =>
    storeFile(client, memory.container(), {
      workspaceId,
      uploadedBy: userId,
      name: '../evidence.png',
      data: Readable.from(PNG),
      area: 'attachments',
    }),
  );

  assert.equal(file.name, 'evidence.png');
  assert.equal(file.contentType, 'image/png');
  assert.equal(file.sizeBytes, PNG.length);
  assert.equal(file.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.match(String(file.blobName), new RegExp(`^attachments/${workspaceId}/[0-9a-f-]{36}$`));
  assert.deepEqual(memory.objects.get(String(file.blobName)), PNG);
  assert.deepEqual(await body(await readFile(memory.container(), file)), PNG);

  await tx(pool, client => discardFile(client, memory.container(), file));
  assert.equal(memory.objects.has(String(file.blobName)), false);
  const kept = await db.query<{ deleted_at: Date | null; version: number }>('select deleted_at, version from file where id = $1', [file.id]);
  const keptRow = kept.rows[0];
  assert.ok(keptRow);
  assert.ok(keptRow.deleted_at);
  assert.equal(keptRow.version, 2);
});

test('storeFile recognises the synthetic workbook by content and can restrict imports to xlsx', async t => {
  if (skipWithoutDatabase(t)) return;
  const { pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();
  const workbook = readFileSync(fileURLToPath(new URL('../../../templates/launch-workbook/launch-workbook-template.xlsx', import.meta.url)));

  const file = await tx(pool, client =>
    storeFile(client, memory.container(), {
      workspaceId,
      uploadedBy: userId,
      name: 'synthetic-launch.xlsx',
      data: Readable.from(workbook),
      area: 'imports',
      allow: ['xlsx'],
    }),
  );

  assert.equal(file.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(file.sizeBytes, workbook.length);
  assert.match(String(file.blobName), new RegExp(`^imports/${workspaceId}/`));
});

test('storeFile refuses unsupported content before writing a row or Blob', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();

  await assert.rejects(
    tx(pool, client =>
      storeFile(client, memory.container(), {
        workspaceId,
        uploadedBy: userId,
        name: 'program.exe',
        data: Readable.from(Buffer.from('4d5a900003000000', 'hex')),
        area: 'attachments',
      }),
    ),
    (error: unknown) => error instanceof ApiError && error.status === 415 && error.code === 'unsupported_media_type',
  );
  assert.equal(memory.objects.size, 0);
  assert.equal(Number((await db.query<{ count: string }>('select count(*) as count from file')).rows[0]?.count ?? '0'), 0);
});

test('storeFile removes a partial Blob when the database insert fails', async t => {
  if (skipWithoutDatabase(t)) return;
  const { pool, workspaceId } = await fixture(t);
  const memory = new MemoryBlobs();

  await assert.rejects(
    tx(pool, client =>
      storeFile(client, memory.container(), {
        workspaceId,
        uploadedBy: randomUUID(),
        name: 'evidence.png',
        data: Readable.from(PNG),
        area: 'attachments',
      }),
    ),
    (error: unknown) => (error as { code?: string }).code === '23503',
  );
  assert.equal(memory.objects.size, 0);
  assert.equal(memory.deleted.length, 1);
});

test('storeFile stops over 25 MiB and removes the partial Blob', async t => {
  if (skipWithoutDatabase(t)) return;
  const { pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();
  const data = Readable.from([Buffer.concat([PNG, Buffer.alloc(UPLOAD_LIMIT)])]);

  await assert.rejects(
    tx(pool, client => storeFile(client, memory.container(), { workspaceId, uploadedBy: userId, name: 'huge.png', data, area: 'attachments' })),
    (error: unknown) => error instanceof ApiError && error.status === 413 && error.code === 'payload_too_large',
  );
  assert.equal(memory.objects.size, 0);
  assert.equal(memory.deleted.length, 1);
  assert.ok(memory.maxChunk <= 64 * 1024, `the sniff replay emitted a ${String(memory.maxChunk)} byte chunk`);
});

test('storeFile rejects a compound binary file renamed to .xls', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();
  const cfb = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(4096)]);

  await assert.rejects(
    tx(pool, client =>
      storeFile(client, memory.container(), {
        workspaceId,
        uploadedBy: userId,
        name: 'not-a-workbook.xls',
        data: Readable.from(cfb),
        area: 'attachments',
      }),
    ),
    (error: unknown) => error instanceof ApiError && error.status === 415,
  );
  assert.equal(memory.objects.size, 0);
  assert.equal(Number((await db.query<{ count: string }>('select count(*) as count from file')).rows[0]?.count ?? '0'), 0);
});

test('storeFile rejects parents from another workspace before uploading', async t => {
  if (skipWithoutDatabase(t)) return;
  const { owner, pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();
  const other = await owner.query<{ id: string }>(`insert into workspace (slug, name) values ('other-files', 'Other files') returning id`);
  const otherWorkspace = other.rows[0]?.id ?? '';
  const project = await owner.query<{ id: string }>(`insert into project (workspace_id, kind, key, name) values ($1, 'general', 'OTH', 'Other') returning id`, [
    otherWorkspace,
  ]);
  const projectId = project.rows[0]?.id ?? '';
  const task = await owner.query<{ id: string }>(
    `insert into task (workspace_id, project_id, key, title, sort_order) values ($1, $2, 'OTH-1', 'Other task', 1) returning id`,
    [otherWorkspace, projectId],
  );
  const taskId = task.rows[0]?.id ?? '';
  const comment = await owner.query<{ id: string }>(
    `insert into comment (workspace_id, task_id, author_id, body) values ($1, $2, $3, 'Other comment') returning id`,
    [otherWorkspace, taskId, userId],
  );
  const cases = [{ projectId }, { taskId }, { commentId: comment.rows[0]?.id ?? '' }];

  for (const parent of cases) {
    await assert.rejects(
      tx(pool, client =>
        storeFile(client, memory.container(), {
          workspaceId,
          uploadedBy: userId,
          name: 'evidence.png',
          data: Readable.from(PNG),
          area: 'attachments',
          ...parent,
        }),
      ),
      (error: unknown) => error instanceof ApiError && error.code === 'validation_failed',
    );
  }
  assert.equal(memory.objects.size, 0);
});

test('a failed cleanup is visible, durable and succeeds on retry', async t => {
  if (skipWithoutDatabase(t)) return;
  const { owner, pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();
  memory.failDeletes = 1;
  let path = '';

  await assert.rejects(
    tx(pool, async client => {
      const file = await storeFile(client, memory.container(), {
        workspaceId,
        uploadedBy: userId,
        name: 'evidence.png',
        data: Readable.from(PNG),
        area: 'attachments',
      });
      path = String(file.blobName);
      throw new Error('force outer rollback');
    }),
    /cleanup was queued/,
  );
  assert.equal(Number((await owner.query<{ count: string }>('select count(*) as count from file')).rows[0]?.count ?? '0'), 0);
  assert.equal(memory.objects.has(path), true);
  const queued = await owner.query<{ attempts: number }>('select attempts from deferred_cleanup where kind = $1 and key = $2', ['blob', path]);
  assert.deepEqual(queued.rows, [{ attempts: 1 }]);

  assert.equal(
    await retryDeferredCleanups(pool, 'blob', async key => {
      await memory.getBlockBlobClient(key).deleteIfExists();
    }),
    1,
  );
  assert.equal(memory.objects.has(path), false);
  assert.equal(Number((await owner.query<{ count: string }>('select count(*) as count from deferred_cleanup')).rows[0]?.count ?? '0'), 0);
});

test('a real Blob is compensated when its outer PostgreSQL transaction rolls back', async t => {
  if (skipWithoutDatabase(t)) return;
  const connectionString = process.env.TEST_BLOB_CONNECTION_STRING?.trim();
  if (!connectionString) {
    if (process.env.CI) throw new Error('TEST_BLOB_CONNECTION_STRING is required in CI for the PostgreSQL + Azurite rollback test.');
    t.skip('TEST_BLOB_CONNECTION_STRING is not set: start the pinned Azurite image to run the real-Blob rollback test');
    return;
  }
  const { owner, pool, workspaceId, userId } = await fixture(t);
  const service = BlobServiceClient.fromConnectionString(connectionString);
  const container = service.getContainerClient(`files-${randomUUID()}`);
  await container.create();
  t.after(() => container.deleteIfExists().then(() => undefined));
  let path = '';

  await assert.rejects(
    tx(pool, async client => {
      const file = await storeFile(client, container, {
        workspaceId,
        uploadedBy: userId,
        name: 'evidence.png',
        data: Readable.from(PNG),
        area: 'attachments',
      });
      path = String(file.blobName);
      assert.equal(await container.getBlobClient(path).exists(), true);
      throw new Error('force rollback after storeFile');
    }),
    /force rollback after storeFile/,
  );
  assert.equal(Number((await owner.query<{ count: string }>('select count(*) as count from file')).rows[0]?.count ?? '0'), 0);
  assert.equal(await container.getBlobClient(path).exists(), false);
});
