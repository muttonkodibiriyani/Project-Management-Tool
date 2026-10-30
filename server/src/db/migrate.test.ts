import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_ROLE_PASSWORD, emptyDatabase, skipWithoutDatabase } from '../testing/database.js';
import { migrate } from './migrate.js';

// Every table of the schema doc (01a18918-7476), so a table dropped from 0001_init.sql fails here.
const TABLES = [
  'activity',
  'app_user',
  'brand',
  'brand_list_entry',
  'brand_market',
  'brand_market_contacts',
  'brand_market_margin',
  'comment',
  'comment_mention',
  'comment_reaction',
  'contact',
  'event',
  'favourite',
  'field_def',
  'file',
  'idempotency_key',
  'import_exception',
  'import_job',
  'import_normalisation',
  'install',
  'launch_reference',
  'launch_store',
  'line_store',
  'list_option',
  'market',
  'milestone',
  'notification',
  'project',
  'project_member',
  'saved_view',
  'store',
  'store_capacity',
  'subtask',
  'task',
  'task_dependency',
  'team',
  'team_member',
  'template',
  'user_session',
  'value_list',
  'vendor',
  'vendor_pack',
  'visit_brand',
  'workspace',
  'workspace_member',
];

test('migrations build the whole schema in an empty database, and a second run applies nothing', async t => {
  if (skipWithoutDatabase(t)) return;
  const db = await emptyDatabase(t);
  const owner = await db.connect();

  assert.deepEqual(await migrate(owner, () => undefined), ['0001_init']);
  const { rows: tables } = await owner.query<{ name: string }>(
    "select table_name as name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
  );
  assert.deepEqual(
    tables.map(row => row.name),
    TABLES,
  );
  const { rows: markets } = await owner.query<{ code: string }>('select code from market order by code');
  assert.deepEqual(
    markets.map(row => row.code),
    ['BHR', 'KSA', 'KWT', 'OMN', 'QAT', 'UAE'],
  );

  assert.deepEqual(await migrate(owner, () => undefined), []);
  const { rows: applied } = await owner.query<{ name: string }>('select name from migrations.pgmigrations');
  assert.deepEqual(
    applied.map(row => row.name),
    ['0001_init'],
  );
});

test('every update moves a row onto the change feed', async t => {
  if (skipWithoutDatabase(t)) return;
  const db = await emptyDatabase(t);
  const owner = await db.connect();
  await migrate(owner, () => undefined);

  const { rows: triggerless } = await owner.query<{ name: string }>(`
    select c.table_name as name from information_schema.columns c
    where c.table_schema = 'public' and c.column_name = 'change_seq'
      and not exists (select 1 from information_schema.triggers g where g.event_object_table = c.table_name and g.trigger_name = c.table_name || '_touch')`);
  assert.deepEqual(triggerless, []);

  const created = await owner.query<{ id: string; change_seq: string }>(
    "insert into workspace (slug, name) values ('synthetic-ws', 'Synthetic') returning id, change_seq",
  );
  const row = created.rows[0];
  assert.ok(row);
  const updated = await owner.query<{ change_seq: string }>("update workspace set name = 'Renamed' where id = $1 returning change_seq", [row.id]);
  assert.ok(BigInt(updated.rows[0]?.change_seq ?? 0) > BigInt(row.change_seq));
});

test('the app role may add activity but never change or delete it, and may not touch the migration record', async t => {
  if (skipWithoutDatabase(t)) return;
  const db = await emptyDatabase(t);
  const owner = await db.connect();
  await migrate(owner, () => undefined);
  const app = await db.connect('lt_app', APP_ROLE_PASSWORD);

  const { rows } = await app.query<{ id: string }>("insert into workspace (slug, name) values ('synthetic-ws', 'Synthetic') returning id");
  const workspaceId = rows[0]?.id;
  await app.query("insert into activity (workspace_id, verb, entity_kind) values ($1, 'created', 'workspace')", [workspaceId]);
  await assert.rejects(app.query("update activity set verb = 'deleted'"), { code: '42501' });
  await assert.rejects(app.query('delete from activity'), { code: '42501' });
  await assert.rejects(app.query("insert into market values ('XXX', 'Nowhere')"), { code: '42501' });
  await assert.rejects(app.query('select * from migrations.pgmigrations'), { code: '42501' });
  await assert.rejects(app.query('create table extra (id int)'), { code: '42501' });
});
