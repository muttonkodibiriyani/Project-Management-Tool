import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import type { FastifyRequest } from 'fastify';
import pg from 'pg';
import { migrate } from '../db/migrate.js';
import { APP_ROLE_PASSWORD, emptyDatabase, skipWithoutDatabase, TEST_DATABASE_URL } from '../testing/database.js';
import { buildXlsx, rowAt, type TestCell } from '../testing/xlsx.js';
import { commitPrepared, prepareAgainstDatabase } from './database.js';
import { prepareImport, type ImportContext, type PreparedImport } from './import.js';
import { KNOWN_LAYOUTS, detectLayout } from './layouts.js';
import { readWorkbook } from './xlsx-read.js';

// Synthetic workbooks only. These rows deliberately do not reproduce any real launch data.
function header(layoutId: string): TestCell[] {
  const layout = KNOWN_LAYOUTS.find(item => item.id === layoutId);
  assert.ok(layout);
  return rowAt(Object.fromEntries(Object.entries(layout.columns).map(([letter, [name]]) => [letter, name ?? `Synthetic ${letter}`])));
}

const context: ImportContext = {
  launch: 'SYNTHETIC 2027',
  storeMap: { S1: 'SA' },
  stores: [{ code: 'SA' }, { code: 'SB' }],
  brands: [],
  vendors: [],
  defaultYear: 2027,
};

function prepared(layoutId: 'launch_tracker' | 'avenues', values: Record<string, TestCell>, name: string): PreparedImport {
  const workbook = readWorkbook(buildXlsx([{ name, rows: [header(layoutId), rowAt(values)] }]));
  const sheet = workbook.sheets[0];
  assert.ok(sheet);
  const detected = detectLayout(sheet);
  assert.equal(detected?.layout.id, layoutId);
  assert.ok(detected);
  return prepareImport(sheet, detected.layout, detected.headerRow, context);
}

async function fixture(t: TestContext) {
  const appPools: pg.Pool[] = [];
  t.after(async () => Promise.all(appPools.map(pool => pool.end())));
  const database = await emptyDatabase(t);
  const admin = await database.connect();
  await migrate(admin, () => undefined);
  const one = async (sql: string, params: unknown[] = []) => {
    const result = await admin.query<{ id: string }>(`${sql} returning id`, params);
    const id = result.rows[0]?.id;
    assert.ok(id);
    return id;
  };
  const count = async (sql: string, params: unknown[] = []) => Number((await admin.query<{ count: string }>(sql, params)).rows[0]?.count ?? 0);
  const workspaceId = await one(`insert into workspace (slug,name) values ('synthetic-imports','Synthetic imports')`);
  const userId = await one(`insert into app_user (email,name,app_roles) values ('importer@example.test','Synthetic Importer',array['Launch.Manager'])`);
  await admin.query(`insert into workspace_member (workspace_id,user_id,gr8r_role) values ($1,$2,'Owner')`, [workspaceId, userId]);
  const projectId = await one(
    `insert into project (workspace_id,kind,key,name,launch_code,market_code,created_by)
     values ($1,'launch','SYN','Synthetic launch','SYNTHETIC 2027','QAT',$2)`,
    [workspaceId, userId],
  );
  const store = async (code: string) => one(`insert into store (workspace_id,code,name,market_code) values ($1,$2,$2,'QAT')`, [workspaceId, code]);
  const sa = await store('SA');
  const sb = await store('SB');
  await admin.query(`insert into launch_store (project_id,store_id,slot) values ($1,$2,1),($1,$3,2)`, [projectId, sa, sb]);

  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${(await admin.query<{ name: string }>('select current_database() as name')).rows[0]?.name ?? ''}`;
  url.username = 'lt_app';
  url.password = APP_ROLE_PASSWORD;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
  appPools.push(pool);
  const request = {
    id: 'synthetic-import-request',
    url: '/api/v1/w/synthetic-imports/imports/test/commit',
    caller: { userId, sessionId: randomUUID(), sessionExpiresAt: new Date(Date.now() + 60_000), roles: ['Launch.Manager'] },
    workspace: {
      id: workspaceId,
      slug: 'synthetic-imports',
      settings: {},
      actor: { userId, roles: ['Launch.Manager'], teams: [] },
    },
  } as unknown as FastifyRequest;

  const job = async () => {
    const fileId = await one(
      `insert into file (workspace_id,name,content_type,size_bytes,sha256,blob_container,blob_name,uploaded_by)
       values ($1,'synthetic.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',1,$2,'imports',$3,$4)`,
      [workspaceId, '0'.repeat(64), `imports/${workspaceId}/${randomUUID()}`, userId],
    );
    return one(
      `insert into import_job (workspace_id,project_id,file_id,sheet,layout,status,created_by)
       values ($1,$2,$3,'Synthetic','launch_tracker','previewed',$4)`,
      [workspaceId, projectId, fileId, userId],
    );
  };
  return { admin, pool, request, projectId, job, count };
}

test('both synthetic layouts commit atomically and a re-import is duplicate-free with a change list', async t => {
  if (skipWithoutDatabase(t)) return;
  const f = await fixture(t);
  const launch = prepared(
    'launch_tracker',
    { D: 'Prestige skincare', G: 'Vendor One L.L.C', H: '30% + 5% marketing', N: 'Y', W: 'PURPLE', X: 'Brand Alpha' },
    'Synthetic',
  );
  assert.ok(launch.normalisations.some(item => item.field === 'S1 Listing' && item.storedAs === 'Yes'));
  assert.deepEqual(
    launch.exceptions.map(item => item.kind).sort(),
    ['unknown_brand', 'unknown_vendor'],
    'the clean-up and exception report exists before commit',
  );

  const firstJob = await f.job();
  const firstDraft = await prepareAgainstDatabase(f.pool, f.projectId, launch);
  assert.deepEqual(firstDraft.plan.summary, { create: 1, update: 0, unchanged: 0, notInFile: 0 });
  const first = await commitPrepared(f.pool, f.request, firstJob, 1, firstDraft);
  assert.deepEqual(first.summary, firstDraft.plan.summary);
  assert.equal(first.changedKeys.length, 1);
  assert.equal(await f.count('select count(*) from task where project_id=$1', [f.projectId]), 1);
  const original = (await f.admin.query<{ id: string; version: number }>('select id,version from task where project_id=$1', [f.projectId])).rows[0];
  assert.ok(original);

  const secondJob = await f.job();
  const secondDraft = await prepareAgainstDatabase(f.pool, f.projectId, launch);
  assert.deepEqual(secondDraft.plan.summary, { create: 0, update: 0, unchanged: 1, notInFile: 0 });
  const second = await commitPrepared(f.pool, f.request, secondJob, 1, secondDraft);
  assert.deepEqual(second.changedKeys, []);
  assert.equal(await f.count('select count(*) from task where project_id=$1', [f.projectId]), 1);
  assert.deepEqual((await f.admin.query<{ id: string; version: number }>('select id,version from task where project_id=$1', [f.projectId])).rows[0], original);

  const edited = prepared(
    'launch_tracker',
    { D: 'Prestige skincare', G: 'Vendor One L.L.C', H: '30% + 5% marketing', N: 'No', W: 'PURPLE', X: 'Brand Alpha' },
    'Synthetic',
  );
  const thirdJob = await f.job();
  const thirdDraft = await prepareAgainstDatabase(f.pool, f.projectId, edited);
  assert.deepEqual(thirdDraft.plan.summary, { create: 0, update: 1, unchanged: 0, notInFile: 0 });
  assert.deepEqual(thirdDraft.plan.changes[0]?.fields, [{ path: 'line.S1 Listing', from: 'Yes', to: 'No' }]);
  const third = await commitPrepared(f.pool, f.request, thirdJob, 1, thirdDraft);
  assert.equal(third.changedKeys.length, 1);
  assert.equal(await f.count('select count(*) from task where project_id=$1', [f.projectId]), 1);

  const avenues = prepared(
    'avenues',
    { B: 'Body', D: 'Vendor Two', F: 'Brand Beta', L: 'Y', R: 0.35, W: 'Contractor Synthetic', X: '9th December' },
    'Synthetic',
  );
  assert.ok(avenues.normalisations.some(item => item.field === 'S1 At launch' && item.storedAs === 'Yes'));
  assert.deepEqual(
    avenues.exceptions.map(item => item.kind),
    ['unknown_brand'],
  );
  const avenuesJob = await f.job();
  const avenuesDraft = await prepareAgainstDatabase(f.pool, f.projectId, avenues);
  const avenuesResult = await commitPrepared(f.pool, f.request, avenuesJob, 1, avenuesDraft);
  assert.equal(avenuesResult.summary.create, 1);
  assert.equal(await f.count('select count(*) from task where project_id=$1', [f.projectId]), 2);

  const broken = prepared('launch_tracker', { D: 'Prestige skincare', H: 0.2, X: 'Atomic Brand One' }, 'Synthetic');
  const secondBrokenLine = structuredClone(broken.lines[0]);
  assert.ok(secondBrokenLine);
  secondBrokenLine.rowNo += 1;
  secondBrokenLine.key = 'body atomic brand two';
  secondBrokenLine.fields.Brand = 'Atomic Brand Two';
  secondBrokenLine.fields.Zone = 'Body';
  secondBrokenLine.fields['External key'] = 'Body Atomic Brand Two';
  secondBrokenLine.distribution.QAT = { Margin: 2, Source: 'Synthetic row 3' };
  broken.lines.push(secondBrokenLine);
  const brokenJob = await f.job();
  const brokenDraft = await prepareAgainstDatabase(f.pool, f.projectId, broken);
  assert.equal(brokenDraft.plan.summary.create, 2);
  await assert.rejects(commitPrepared(f.pool, f.request, brokenJob, 1, brokenDraft), (error: unknown) => (error as { code?: string }).code === '23514');
  assert.equal(await f.count('select count(*) from task where project_id=$1', [f.projectId]), 2);
  assert.equal(await f.count(`select count(*) from brand where name like 'Atomic Brand %'`), 0);
  assert.equal((await f.admin.query<{ status: string }>('select status from import_job where id=$1', [brokenJob])).rows[0]?.status, 'previewed');
});
