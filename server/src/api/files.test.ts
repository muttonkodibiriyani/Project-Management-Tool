import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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

async function crashChild(environment: Record<string, string>): Promise<void> {
  const childPath = fileURLToPath(new URL('./files.crash-child.js', import.meta.url));
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [childPath], {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      errors += chunk;
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 42) resolve();
      else reject(new Error(`Blob crash fixture exited ${String(code)}: ${errors}`));
    });
  });
}

async function fixture(t: TestContext, options: { max?: number; connectionTimeoutMillis?: number } = {}) {
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
  const pool = new pg.Pool({ connectionString: url.toString(), max: options.max ?? 3, connectionTimeoutMillis: options.connectionTimeoutMillis });
  closing.push(() => pool.end());
  return {
    db: db as unknown as pg.PoolClient,
    owner,
    pool,
    databaseUrl: url.toString(),
    workspaceId: workspace.rows[0]?.id ?? '',
    userId: user.rows[0]?.id ?? '',
  };
}

test('storeFile sniffs, hashes and streams an attachment; read and discard use its opaque Blob name', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();

  const staged = await storeFile(pool, memory.container(), {
    workspaceId,
    uploadedBy: userId,
    name: '../evidence.png',
    data: Readable.from(PNG),
    area: 'attachments',
  });
  const file = await tx(pool, client => staged.attach(client));

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

  const staged = await storeFile(pool, memory.container(), {
    workspaceId,
    uploadedBy: userId,
    name: 'synthetic-launch.xlsx',
    data: Readable.from(workbook),
    area: 'imports',
    allow: ['xlsx'],
  });
  const file = await tx(pool, client => staged.attach(client));

  assert.equal(file.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(file.sizeBytes, workbook.length);
  assert.match(String(file.blobName), new RegExp(`^imports/${workspaceId}/`));
});

test('storeFile refuses unsupported content before writing a row or Blob', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();

  await assert.rejects(
    storeFile(pool, memory.container(), {
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
  const { pool, workspaceId } = await fixture(t);
  const memory = new MemoryBlobs();

  const staged = await storeFile(pool, memory.container(), {
    workspaceId,
    uploadedBy: randomUUID(),
    name: 'evidence.png',
    data: Readable.from(PNG),
    area: 'attachments',
  });
  await assert.rejects(
    tx(pool, client => staged.attach(client)),
    (error: unknown) => (error as { code?: string }).code === '23503',
  );
  assert.equal(memory.objects.size, 0);
  assert.equal(memory.deleted.length, 1);
});

test('storeFile stops over 25 MiB and removes the partial Blob', async t => {
  if (skipWithoutDatabase(t)) return;
  const { pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();
  const prefix = Buffer.alloc(64 * 1024);
  PNG.copy(prefix);
  const data = Readable.from([prefix, Buffer.alloc(UPLOAD_LIMIT)]);

  await assert.rejects(
    storeFile(pool, memory.container(), { workspaceId, uploadedBy: userId, name: 'huge.png', data, area: 'attachments' }),
    (error: unknown) => error instanceof ApiError && error.status === 413 && error.code === 'payload_too_large',
  );
  assert.equal(memory.objects.size, 0);
  assert.equal(memory.deleted.length, 1);
  assert.ok(memory.maxChunk <= 64 * 1024, `the bounded upload emitted a ${String(memory.maxChunk)} byte chunk`);
});

test('storeFile bounds a large chunk that arrives after content sniffing', async t => {
  if (skipWithoutDatabase(t)) return;
  const { pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();
  const prefix = Buffer.alloc(64 * 1024);
  PNG.copy(prefix);
  const later = Buffer.alloc(20 * 1024 * 1024, 1);

  const staged = await storeFile(pool, memory.container(), {
    workspaceId,
    uploadedBy: userId,
    name: 'large.png',
    data: Readable.from([prefix, later]),
    area: 'attachments',
  });
  const file = await tx(pool, client => staged.attach(client));

  assert.equal(file.sizeBytes, prefix.length + later.length);
  assert.ok(memory.maxChunk <= 64 * 1024, `the later source value reached uploadStream as ${String(memory.maxChunk)} bytes`);
});

test('storeFile rejects a compound binary file renamed to .xls', async t => {
  if (skipWithoutDatabase(t)) return;
  const { db, pool, workspaceId, userId } = await fixture(t);
  const memory = new MemoryBlobs();
  const cfb = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(4096)]);

  await assert.rejects(
    storeFile(pool, memory.container(), {
      workspaceId,
      uploadedBy: userId,
      name: 'not-a-workbook.xls',
      data: Readable.from(cfb),
      area: 'attachments',
    }),
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
      storeFile(pool, memory.container(), {
        workspaceId,
        uploadedBy: userId,
        name: 'evidence.png',
        data: Readable.from(PNG),
        area: 'attachments',
        ...parent,
      }),
      (error: unknown) => error instanceof ApiError && error.code === 'validation_failed',
    );
  }
  assert.equal(memory.objects.size, 0);
});

test('a failed cleanup is visible, durable and succeeds on retry', async t => {
  if (skipWithoutDatabase(t)) return;
  const { owner, pool, workspaceId, userId } = await fixture(t, { max: 1, connectionTimeoutMillis: 250 });
  const memory = new MemoryBlobs();
  memory.failDeletes = 1;
  const staged = await storeFile(pool, memory.container(), {
    workspaceId,
    uploadedBy: userId,
    name: 'evidence.png',
    data: Readable.from(PNG),
    area: 'attachments',
  });
  const path = staged.blobName;

  await assert.rejects(
    tx(pool, async client => {
      await staged.attach(client);
      throw new Error('force outer rollback');
    }),
    /cleanup was queued/,
  );
  assert.equal(Number((await owner.query<{ count: string }>('select count(*) as count from file')).rows[0]?.count ?? '0'), 0);
  assert.equal(memory.objects.has(path), true);
  const queued = await owner.query<{ attempts: number }>('select attempts from deferred_cleanup where kind = $1 and key = $2', ['blob', path]);
  assert.deepEqual(queued.rows, [{ attempts: 1 }]);

  const retried = await retryDeferredCleanups(pool, 'blob', async item => {
    await memory.getBlockBlobClient(item.key).deleteIfExists();
  });
  assert.equal(retried.completed, 1);
  assert.equal(retried.queueDepth, 0);
  assert.equal(memory.objects.has(path), false);
  assert.equal(Number((await owner.query<{ count: string }>('select count(*) as count from deferred_cleanup')).rows[0]?.count ?? '0'), 0);
});

test('a real Blob is compensated after rollback even when the PostgreSQL pool has one connection', async t => {
  if (skipWithoutDatabase(t)) return;
  const connectionString = process.env.TEST_BLOB_CONNECTION_STRING?.trim();
  if (!connectionString) {
    if (process.env.CI) throw new Error('TEST_BLOB_CONNECTION_STRING is required in CI for the PostgreSQL + Azurite rollback test.');
    t.skip('TEST_BLOB_CONNECTION_STRING is not set: start the pinned Azurite image to run the real-Blob rollback test');
    return;
  }
  const { owner, pool, workspaceId, userId } = await fixture(t, { max: 1, connectionTimeoutMillis: 250 });
  const service = BlobServiceClient.fromConnectionString(connectionString);
  const container = service.getContainerClient(`files-${randomUUID()}`);
  await container.create();
  t.after(() => container.deleteIfExists().then(() => undefined));
  const staged = await storeFile(pool, container, {
    workspaceId,
    uploadedBy: userId,
    name: 'evidence.png',
    data: Readable.from(PNG),
    area: 'attachments',
  });
  const path = staged.blobName;

  await assert.rejects(
    tx(pool, async client => {
      await staged.attach(client);
      assert.equal(await container.getBlobClient(path).exists(), true);
      throw new Error('force rollback after storeFile');
    }),
    /force rollback after storeFile/,
  );
  assert.equal(Number((await owner.query<{ count: string }>('select count(*) as count from file')).rows[0]?.count ?? '0'), 0);
  assert.equal(await container.getBlobClient(path).exists(), false);
  assert.equal(Number((await owner.query<{ count: string }>('select count(*) as count from deferred_cleanup')).rows[0]?.count ?? '0'), 0);
});

test('a real Blob delete failure stays workspace-scoped and retryable', async t => {
  if (skipWithoutDatabase(t)) return;
  const connectionString = process.env.TEST_BLOB_CONNECTION_STRING?.trim();
  if (!connectionString) {
    if (process.env.CI) throw new Error('TEST_BLOB_CONNECTION_STRING is required in CI for the PostgreSQL + Azurite cleanup test.');
    t.skip('TEST_BLOB_CONNECTION_STRING is not set: start the pinned Azurite image to run the real-Blob cleanup test');
    return;
  }
  const { owner, pool, workspaceId, userId } = await fixture(t, { max: 1, connectionTimeoutMillis: 250 });
  const service = BlobServiceClient.fromConnectionString(connectionString);
  const container = service.getContainerClient(`files-${randomUUID()}`);
  await container.create();
  t.after(() => container.deleteIfExists().then(() => undefined));
  let failDelete = true;
  const getBlockBlobClient = container.getBlockBlobClient.bind(container);
  container.getBlockBlobClient = name => {
    const block = getBlockBlobClient(name);
    const deleteIfExists = block.deleteIfExists.bind(block);
    block.deleteIfExists = (...args) => {
      if (failDelete) {
        failDelete = false;
        return Promise.reject(new Error('synthetic Azurite delete outage'));
      }
      return deleteIfExists(...args);
    };
    return block;
  };
  const staged = await storeFile(pool, container, {
    workspaceId,
    uploadedBy: userId,
    name: 'cleanup.png',
    data: Readable.from(PNG),
    area: 'attachments',
  });

  await assert.rejects(
    tx(pool, async client => {
      await staged.attach(client);
      throw new Error('force rollback before failed delete');
    }),
    /cleanup was queued/,
  );
  assert.equal(await container.getBlobClient(staged.blobName).exists(), true);
  const queued = await owner.query<{ workspace_id: string; attempts: number }>(
    'select workspace_id, attempts from deferred_cleanup where kind = $1 and key = $2',
    ['blob', staged.blobName],
  );
  assert.deepEqual(queued.rows, [{ workspace_id: workspaceId, attempts: 1 }]);

  const retried = await retryDeferredCleanups(pool, 'blob', async item => {
    await container.getBlockBlobClient(item.key).deleteIfExists({ deleteSnapshots: 'include' });
  });
  assert.equal(retried.completed, 1);
  assert.equal(await container.getBlobClient(staged.blobName).exists(), false);
});

test('durable intents reconcile child exits after intent, after upload and after commit', async t => {
  if (skipWithoutDatabase(t)) return;
  const connectionString = process.env.TEST_BLOB_CONNECTION_STRING?.trim();
  if (!connectionString) {
    if (process.env.CI) throw new Error('TEST_BLOB_CONNECTION_STRING is required in CI for the PostgreSQL + Azurite crash tests.');
    t.skip('TEST_BLOB_CONNECTION_STRING is not set: start the pinned Azurite image to run the real-Blob crash tests');
    return;
  }
  const { owner, pool, databaseUrl, workspaceId, userId } = await fixture(t, { max: 1, connectionTimeoutMillis: 500 });
  const service = BlobServiceClient.fromConnectionString(connectionString);

  for (const phase of ['after-intent', 'after-upload', 'after-commit'] as const) {
    const container = service.getContainerClient(`crash-${randomUUID()}`);
    await container.create();
    t.after(() => container.deleteIfExists().then(() => undefined));
    await crashChild({
      CRASH_PHASE: phase,
      CRASH_DATABASE_URL: databaseUrl,
      CRASH_BLOB_CONNECTION_STRING: connectionString,
      CRASH_CONTAINER: container.containerName,
      CRASH_WORKSPACE_ID: workspaceId,
      CRASH_USER_ID: userId,
    });

    const intents = await owner.query<{ key: string; workspace_id: string }>(
      'select key, workspace_id from deferred_cleanup where kind = $1 and workspace_id = $2',
      ['blob', workspaceId],
    );
    assert.equal(intents.rows.length, 1, `${phase} left one discoverable intent`);
    const intent = intents.rows[0];
    assert.ok(intent);
    assert.equal(intent.workspace_id, workspaceId);
    const before = await owner.query<{ count: number }>('select count(*)::int as count from file where workspace_id = $1 and blob_name = $2', [
      workspaceId,
      intent.key,
    ]);
    const committed = phase === 'after-commit';
    assert.equal(before.rows[0]?.count, committed ? 1 : 0);
    assert.equal(await container.getBlobClient(intent.key).exists(), phase !== 'after-intent');

    await owner.query('update deferred_cleanup set available_at = now() where kind = $1 and workspace_id = $2 and key = $3', ['blob', workspaceId, intent.key]);
    const report = await retryDeferredCleanups(pool, 'blob', async item => {
      const live = await pool.query<{ found: boolean }>('select true as found from file where workspace_id = $1 and blob_name = $2 and deleted_at is null', [
        item.workspaceId,
        item.key,
      ]);
      if (!live.rows[0]?.found) await container.getBlockBlobClient(item.key).deleteIfExists({ deleteSnapshots: 'include' });
    });
    assert.equal(report.completed, 1);
    assert.equal(report.queueDepth, 0);
    assert.equal(await container.getBlobClient(intent.key).exists(), committed, `${phase} keeps a committed Blob only`);
  }
});
