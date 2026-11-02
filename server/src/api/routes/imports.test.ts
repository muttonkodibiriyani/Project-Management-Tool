import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import type { ContainerClient } from '@azure/storage-blob';
import type { LightMyRequestResponse } from 'fastify';
import { apiFixture, ifMatch, IMPORT_ROUTES, WS, type Fixture } from '../../testing/api.js';
import { skipWithoutDatabase } from '../../testing/database.js';
import { buildXlsx, rowAt, type TestCell } from '../../testing/xlsx.js';
import { KNOWN_LAYOUTS } from '../../excel/layouts.js';
import { readWorkbook } from '../../excel/xlsx-read.js';
import { UPLOAD_LIMIT } from '../files.js';

const W = `/w/${WS}`;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

class MemoryBlobs {
  readonly objects = new Map<string, Buffer>();

  getBlockBlobClient(name: string) {
    return {
      uploadStream: async (stream: NodeJS.ReadableStream) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream as AsyncIterable<Uint8Array | string>) chunks.push(Buffer.from(chunk));
        this.objects.set(name, Buffer.concat(chunks));
      },
      deleteIfExists: () => {
        const succeeded = this.objects.delete(name);
        return Promise.resolve({ succeeded });
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

interface ImportJob {
  id: string;
  fileName: string;
  status: string;
  version: number;
  sheets?: { name: string; detectedLayout: string | null }[];
  summary?: { summary?: { create: number; update: number; unchanged: number; notInFile: number }; changedKeys?: string[] };
}

interface Preview {
  import: ImportJob;
  summary: { lines: { create: number; update: number; unchanged: number; notInFile: number }; exceptions: number; normalised: number };
  normalisations: { id: number; field: string; original: string; storedAs: string }[];
  changes: { action: string; fields: { path: string; from: unknown; to: unknown }[] }[];
}

interface Listed<T> {
  items: T[];
  nextCursor: null;
}

interface ImportException {
  id: number;
  kind: string;
  resolution: { action: string; to?: string };
}

function header(layoutId: 'launch_tracker' | 'avenues'): TestCell[] {
  const layout = KNOWN_LAYOUTS.find(item => item.id === layoutId);
  assert.ok(layout);
  return rowAt(Object.fromEntries(Object.entries(layout.columns).map(([letter, [name]]) => [letter, name ?? `Synthetic ${letter}`])));
}

function launchTracker(listing: 'Y' | 'No' = 'Y'): Buffer {
  return Buffer.from(
    buildXlsx([
      {
        name: 'LAUNCH TRACKER',
        rows: [
          ['Synthetic launch tracker'],
          [],
          header('launch_tracker'),
          rowAt({ D: 'Prestige skincare', G: 'Vendor One L.L.C', H: '30% + 5% marketing', N: listing, W: 'PURPLE', X: 'Brand Alpha' }),
        ],
      },
    ]),
  );
}

function avenues(): Buffer {
  return Buffer.from(
    buildXlsx([
      {
        name: 'AVENUES',
        rows: [header('avenues'), rowAt({ B: 'Body', D: 'Vendor Two', F: 'Brand Beta', L: 'Y', R: 0.35, W: 'Contractor Synthetic', X: '9th December' })],
      },
    ]),
  );
}

function multipart(bytes: Buffer, filename = 'synthetic.xlsx') {
  const boundary = '----launch-tracker-synthetic-boundary';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${XLSX}\r\n\r\n`);
  return {
    body: Buffer.concat([head, bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(f: Fixture, bytes: Buffer, user: 'manager' | 'brand' = 'manager'): Promise<LightMyRequestResponse> {
  const form = multipart(bytes);
  return f.call(user, 'POST', `${W}/imports`, { body: form.body, headers: form.headers });
}

async function configure(f: Fixture, bytes: Buffer, projectId: string, layout: 'launch_tracker' | 'avenues', sheet: string) {
  const created = await upload(f, bytes);
  assert.equal(created.statusCode, 201, created.body);
  const job = created.json<ImportJob>();
  assert.equal(job.fileName, 'synthetic.xlsx');
  assert.deepEqual(job.sheets, [{ name: sheet, rows: 1, detectedLayout: layout }]);

  const read = await f.call('manager', 'GET', `${W}/imports/${job.id}`);
  assert.equal(read.statusCode, 200);
  const mapped = await f.call('manager', 'PATCH', `${W}/imports/${job.id}`, {
    headers: ifMatch(read),
    body: { sheet, layout, projectId, storeMap: { S1: f.stores.DFC }, mapping: {} },
  });
  assert.equal(mapped.statusCode, 200, mapped.body);
  const preview = await f.call('manager', 'POST', `${W}/imports/${job.id}/preview`, { headers: ifMatch(mapped) });
  assert.equal(preview.statusCode, 200, preview.body);
  return { id: job.id, preview, body: preview.json<Preview>() };
}

test('authenticated import routes preview reviews, commit both layouts, re-import without duplicates, and protect exports', async t => {
  if (skipWithoutDatabase(t)) return;
  const memory = new MemoryBlobs();
  const f = await apiFixture(t, memory.container());
  t.after(() => {
    f.assertCovered(IMPORT_ROUTES);
  });

  const projectResponse = await f.call('manager', 'POST', `${W}/projects`, {
    body: {
      name: 'Synthetic workbook launch',
      key: 'SYN',
      kind: 'launch',
      templateId: f.templateId,
      marketCode: 'QAT',
      stores: [
        { storeId: f.stores.DFC, slot: 1 },
        { storeId: f.stores.VLG, slot: 2 },
      ],
    },
  });
  assert.equal(projectResponse.statusCode, 201, projectResponse.body);
  const projectId = projectResponse.json<{ id: string }>().id;

  const refusedBefore = Number((await f.db.query<{ count: string }>('select count(*) as count from import_job')).rows[0]?.count ?? '0');
  const refused = await upload(f, launchTracker(), 'brand');
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json<{ code: string }>().code, 'forbidden');
  assert.equal(Number((await f.db.query<{ count: string }>('select count(*) as count from import_job')).rows[0]?.count ?? '0'), refusedBefore);

  await f.db.query(`
    create function reject_synthetic_import() returns trigger language plpgsql as $$
    begin
      if exists (select 1 from file where id = new.file_id and name = 'rollback.xlsx') then
        raise exception 'synthetic import_job failure';
      end if;
      return new;
    end $$;
    create trigger reject_synthetic_import before insert on import_job for each row execute function reject_synthetic_import();
  `);
  const blobsBeforeRollback = memory.objects.size;
  const intentsBeforeRollback = Number((await f.db.query<{ count: string }>('select count(*) as count from deferred_cleanup')).rows[0]?.count ?? '0');
  const rollbackForm = multipart(launchTracker(), 'rollback.xlsx');
  const rolledBack = await f.call('manager', 'POST', `${W}/imports`, { body: rollbackForm.body, headers: rollbackForm.headers });
  assert.equal(rolledBack.statusCode, 500);
  assert.equal(memory.objects.size, blobsBeforeRollback, 'a failed outer transaction compensates the uploaded Blob');
  assert.equal(Number((await f.db.query<{ count: string }>(`select count(*) as count from file where name='rollback.xlsx'`)).rows[0]?.count ?? '0'), 0);
  assert.equal(
    Number((await f.db.query<{ count: string }>('select count(*) as count from deferred_cleanup')).rows[0]?.count ?? '0'),
    intentsBeforeRollback,
    'successful rollback cleanup finalises the durable intent',
  );
  await f.db.query('drop trigger reject_synthetic_import on import_job; drop function reject_synthetic_import()');

  const first = await configure(f, launchTracker(), projectId, 'launch_tracker', 'LAUNCH TRACKER');
  assert.deepEqual(first.body.summary.lines, { create: 1, update: 0, unchanged: 0, notInFile: 0 });
  assert.ok(first.body.normalisations.some(item => item.field === 'S1 Listing' && item.original === 'Y' && item.storedAs === 'Yes'));
  assert.ok(first.body.summary.exceptions >= 2);

  const normalisations = await f.call('manager', 'GET', `${W}/imports/${first.id}/normalisations`);
  const listing = normalisations.json<Listed<{ id: number; field: string; storedAs: string }>>().items.find(item => item.field === 'S1 Listing');
  assert.ok(listing);
  const keptNormalisation = await f.call('manager', 'PATCH', `${W}/imports/${first.id}/normalisations/${String(listing.id)}`, {
    body: { storedAs: listing.storedAs },
  });
  assert.equal(keptNormalisation.statusCode, 200);

  const exceptions = await f.call('manager', 'GET', `${W}/imports/${first.id}/exceptions?kind=unknown_brand`);
  const brandException = exceptions.json<Listed<ImportException>>().items[0];
  assert.ok(brandException);
  const keptException = await f.call('manager', 'PATCH', `${W}/imports/${first.id}/exceptions/${String(brandException.id)}`, {
    body: { resolution: { action: 'create' } },
  });
  assert.equal(keptException.statusCode, 200);

  const reviewed = await f.call('manager', 'GET', `${W}/imports/${first.id}`);
  const reviewedPreview = await f.call('manager', 'POST', `${W}/imports/${first.id}/preview`, { headers: ifMatch(reviewed) });
  assert.equal(reviewedPreview.statusCode, 200, reviewedPreview.body);
  const committed = await f.call('manager', 'POST', `${W}/imports/${first.id}/commit`, { headers: ifMatch(reviewedPreview) });
  assert.equal(committed.statusCode, 200, committed.body);
  assert.equal(committed.json<ImportJob>().status, 'committed');
  assert.deepEqual(committed.json<ImportJob>().summary?.summary, { create: 1, update: 0, unchanged: 0, notInFile: 0 });
  const originalTask = (await f.db.query<{ id: string; version: number }>('select id,version from task where project_id=$1', [projectId])).rows[0];
  assert.ok(originalTask);

  const same = await configure(f, launchTracker(), projectId, 'launch_tracker', 'LAUNCH TRACKER');
  assert.deepEqual(same.body.changes, []);
  assert.deepEqual(same.body.summary.lines, { create: 0, update: 0, unchanged: 1, notInFile: 0 });
  const sameCommit = await f.call('manager', 'POST', `${W}/imports/${same.id}/commit`, { headers: ifMatch(same.preview) });
  assert.equal(sameCommit.statusCode, 200, sameCommit.body);
  assert.deepEqual(sameCommit.json<ImportJob>().summary?.changedKeys, []);
  assert.equal(Number((await f.db.query<{ count: string }>('select count(*) as count from task where project_id=$1', [projectId])).rows[0]?.count ?? '0'), 1);
  assert.deepEqual((await f.db.query<{ id: string; version: number }>('select id,version from task where project_id=$1', [projectId])).rows[0], originalTask);

  const edited = await configure(f, launchTracker('No'), projectId, 'launch_tracker', 'LAUNCH TRACKER');
  assert.deepEqual(edited.body.summary.lines, { create: 0, update: 1, unchanged: 0, notInFile: 0 });
  assert.deepEqual(edited.body.changes[0]?.fields, [{ path: 'line.S1 Listing', from: 'Yes', to: 'No' }]);
  const editedCommit = await f.call('manager', 'POST', `${W}/imports/${edited.id}/commit`, { headers: ifMatch(edited.preview) });
  assert.equal(editedCommit.statusCode, 200, editedCommit.body);
  assert.equal(editedCommit.json<ImportJob>().summary?.changedKeys?.length, 1);
  assert.equal(Number((await f.db.query<{ count: string }>('select count(*) as count from task where project_id=$1', [projectId])).rows[0]?.count ?? '0'), 1);

  const secondLayout = await configure(f, avenues(), projectId, 'avenues', 'AVENUES');
  assert.ok(secondLayout.body.normalisations.some(item => item.field === 'S1 At launch' && item.storedAs === 'Yes'));
  assert.ok(secondLayout.body.summary.exceptions >= 1);
  const avenuesCommit = await f.call('manager', 'POST', `${W}/imports/${secondLayout.id}/commit`, { headers: ifMatch(secondLayout.preview) });
  assert.equal(avenuesCommit.statusCode, 200, avenuesCommit.body);
  assert.equal(Number((await f.db.query<{ count: string }>('select count(*) as count from task where project_id=$1', [projectId])).rows[0]?.count ?? '0'), 2);

  const sameAvenues = await configure(f, avenues(), projectId, 'avenues', 'AVENUES');
  assert.deepEqual(sameAvenues.body.changes, []);
  assert.deepEqual(sameAvenues.body.summary.lines, { create: 0, update: 0, unchanged: 1, notInFile: 1 });
  const sameAvenuesCommit = await f.call('manager', 'POST', `${W}/imports/${sameAvenues.id}/commit`, { headers: ifMatch(sameAvenues.preview) });
  assert.equal(sameAvenuesCommit.statusCode, 200, sameAvenuesCommit.body);
  assert.deepEqual(sameAvenuesCommit.json<ImportJob>().summary?.changedKeys, []);
  assert.equal(Number((await f.db.query<{ count: string }>('select count(*) as count from task where project_id=$1', [projectId])).rows[0]?.count ?? '0'), 2);

  const cancelUpload = await upload(f, launchTracker());
  const cancelled = await f.call('manager', 'POST', `${W}/imports/${cancelUpload.json<ImportJob>().id}/cancel`, { headers: ifMatch(cancelUpload) });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(cancelled.json<ImportJob>().status, 'cancelled');
  assert.equal(memory.objects.size, 5, 'the cancelled sixth upload was removed from Blob storage');

  const bad = multipart(Buffer.from('not an xlsx'));
  const invalid = await f.call('manager', 'POST', `${W}/imports`, { body: bad.body, headers: bad.headers });
  assert.equal(invalid.statusCode, 422);
  assert.equal(invalid.json<{ code: string }>().code, 'not_xlsx');
  assert.match(invalid.json<{ detail: string }>().detail, /Export it as Excel Workbook/);

  const oversizedBytes = Buffer.alloc(UPLOAD_LIMIT + 1);
  oversizedBytes.set([0x50, 0x4b, 0x03, 0x04]);
  const oversized = multipart(oversizedBytes);
  const oversizedResponse = await f.call('manager', 'POST', `${W}/imports`, { body: oversized.body, headers: oversized.headers });
  assert.equal(oversizedResponse.statusCode, 413);
  assert.equal(oversizedResponse.json<{ code: string }>().code, 'payload_too_large');
  assert.match(oversizedResponse.json<{ detail: string }>().detail, /over 25 MiB/);

  const bomb = multipart(
    Buffer.from(
      buildXlsx([{ name: 'LAUNCH TRACKER', rows: [header('launch_tracker')] }], {
        parts: { 'xl/worksheets/sheet1.xml': new Uint8Array(8 * 1024 * 1024) },
      }),
    ),
  );
  const bombResponse = await f.call('manager', 'POST', `${W}/imports`, { body: bomb.body, headers: bomb.headers });
  assert.equal(bombResponse.statusCode, 422);
  assert.equal(bombResponse.json<{ code: string }>().code, 'zip_bomb');
  assert.match(bombResponse.json<{ detail: string }>().detail, /upload|opened/);

  const adminCsv = await f.call('admin', 'GET', `${W}/projects/${projectId}/export?format=csv&scope=distribution`);
  assert.equal(adminCsv.statusCode, 200, adminCsv.body);
  assert.match(adminCsv.body, /Margin/);
  assert.match(adminCsv.body, /0\.35/);
  const restrictedCsv = await f.call('brand', 'GET', `${W}/projects/${projectId}/export?format=csv&scope=distribution`);
  assert.equal(restrictedCsv.statusCode, 200, restrictedCsv.body);
  assert.doesNotMatch(restrictedCsv.body.split('\n')[0] ?? '', /Margin/);
  assert.doesNotMatch(restrictedCsv.body, /0\.35/);

  const workbook = await f.call('admin', 'GET', `${W}/projects/${projectId}/export?format=workbook`);
  assert.equal(workbook.statusCode, 200, workbook.body);
  assert.ok(readWorkbook(workbook.rawPayload).sheets.some(sheet => sheet.name === 'Lines'));
  const vendorId = (await f.db.query<{ id: string }>('select id from vendor where workspace_id=$1 order by name limit 1', [f.workspaceId])).rows[0]?.id;
  assert.ok(vendorId);
  const vendorPack = await f.call('admin', 'GET', `${W}/projects/${projectId}/export/vendor-pack?vendorId=${vendorId}`);
  assert.equal(vendorPack.statusCode, 200, vendorPack.body);
  assert.ok(readWorkbook(vendorPack.rawPayload).sheets.length > 0);
  const schedule = await f.call('admin', 'GET', `${W}/projects/${projectId}/export/install-schedule?storeId=${f.stores.DFC}`);
  assert.equal(schedule.statusCode, 200, schedule.body);
  assert.ok(readWorkbook(schedule.rawPayload).sheets.length > 0);
});
