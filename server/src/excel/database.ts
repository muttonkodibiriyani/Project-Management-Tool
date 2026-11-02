import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { callerOf, workspaceOf } from '../api/context.js';
import { record } from '../api/rows.js';
import { tx, type Db } from '../db/tx.js';
import { alnumKey, matchKey } from './clean.js';
import { planReimport, type ExistingLine, type Fields, type ImportedLine, type PreparedImport, type ReimportPlan, type Value } from './import.js';
import type { OrganisedRows } from './exports.js';
import type { TableRow } from './xlsx-write.js';

type JsonObject = Record<string, Value>;
type Row = Record<string, unknown>;

export interface PreparedDraft {
  prepared: PreparedImport;
  plan: ReimportPlan;
  /** Task key → version at preview time, for an actionable concurrent-edit conflict. */
  versions: Record<string, number>;
}

interface ProjectRow {
  id: string;
  key: string;
  launch_code: string | null;
  next_task_no: number;
}

interface StoreRow {
  id: string;
  code: string;
  slot: number | null;
}

const object = (value: unknown): JsonObject => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {});

function set(out: Record<string, Value>, path: string, value: unknown): void {
  if (value === undefined) return;
  if (value === null || typeof value === 'string' || typeof value === 'number') out[path] = value;
  else if (typeof value === 'boolean') out[path] = value ? 'Yes' : 'No';
}

function mergeValues(before: JsonObject, patch: Fields): JsonObject {
  const cleared = new Set(
    Object.entries(patch)
      .filter(([, value]) => value === null)
      .map(([key]) => key),
  );
  return Object.fromEntries([...Object.entries(before), ...Object.entries(patch)].filter(([key, value]) => value !== null && !cleared.has(key)));
}

const DIST_COLUMNS: Record<string, string> = {
  'Distribution status': 'distribution_status',
  Distributor: 'distributor_id',
  'Distributor as written': 'distributor_as_written',
  Exclusive: 'exclusive',
  'Exclusive months': 'exclusive_months',
  'Registration route': 'registration_route',
  Notes: 'notes',
};

const INSTALL_COLUMNS: Record<string, string> = {
  'Host group': 'host_group',
  Vendor: 'vendor_id',
  'Vendor as written': 'vendor_as_written',
  Brand: 'brand',
  Zone: 'zone_as_written',
  'Fixture as written': 'fixture_as_written',
  'Vendor pack': 'vendor_pack',
  'Install start': 'install_start',
  'Install end': 'install_end',
  'Install status': 'install_status',
  Contractor: 'contractor',
  'Delivery date': 'delivery_date',
  'Delivery status': 'delivery_status',
  'VM status': 'vm_status',
  'Wall perimeter': 'wall_perimeter',
  'Email sent': 'email_sent',
  'Email sent by': 'email_sent_by',
  Notes: 'notes',
};

export async function projectStores(db: Db, workspaceId: string, projectId: string): Promise<StoreRow[]> {
  const { rows } = await db.query<StoreRow>(
    `select s.id, s.code, ls.slot
       from store s left join launch_store ls on ls.store_id = s.id and ls.project_id = $2 and ls.deleted_at is null
      where s.workspace_id = $1 and s.deleted_at is null order by ls.slot nulls last, s.code`,
    [workspaceId, projectId],
  );
  return rows;
}

/** Existing launch rows in the same flat shape as the pure import engine. */
export async function loadExisting(db: Db, projectId: string): Promise<{ lines: ExistingLine[]; versions: Record<string, number> }> {
  const { rows: tasks } = await db.query<Row>(
    `select t.*, b.name as brand, b.host_group, p.launch_code
       from task t left join brand b on b.id = t.brand_id join project p on p.id = t.project_id
      where t.project_id = $1 and t.kind = 'line' and t.deleted_at is null order by t.key`,
    [projectId],
  );
  const taskIds = tasks.map(row => String(row.id));
  const lineStores = taskIds.length
    ? (
        await db.query<Row>(
          `select x.*, s.code, ls.slot
             from line_store x join store s on s.id = x.store_id
             left join launch_store ls on ls.project_id = $1 and ls.store_id = x.store_id and ls.deleted_at is null
            where x.task_id = any($2::uuid[]) and x.deleted_at is null`,
          [projectId, taskIds],
        )
      ).rows
    : [];
  const markets = taskIds.length
    ? (
        await db.query<Row>(
          `select t.id as task_id, bm.*, v.name as distributor, m.margin, m.extra_margin, m.terms as margin_terms,
                  m.as_written as margin_as_written, c.contacts_as_written
             from task t join brand_market bm on bm.brand_id = t.brand_id and bm.deleted_at is null
             left join vendor v on v.id = bm.distributor_id
             left join brand_market_margin m on m.brand_market_id = bm.id
             left join brand_market_contacts c on c.brand_market_id = bm.id
            where t.id = any($1::uuid[])`,
          [taskIds],
        )
      ).rows
    : [];
  const installs = taskIds.length
    ? (
        await db.query<Row>(
          `select i.*, s.code as store, v.name as vendor from install i join store s on s.id = i.store_id
             left join vendor v on v.id = i.vendor_id where i.task_id = any($1::uuid[]) and i.deleted_at is null`,
          [taskIds],
        )
      ).rows
    : [];

  const versions: Record<string, number> = {};
  const lines = tasks.map((task): ExistingLine => {
    const values: Record<string, Value> = {};
    for (const [key, value] of Object.entries(object(task.values))) set(values, `line.${key}`, value);
    set(values, 'line.Line ID', task.key);
    set(values, 'line.Launch', task.launch_code);
    set(values, 'line.Brand', task.brand);
    set(values, 'line.Host group', task.host_group);
    set(values, 'line.External key', task.external_key);
    set(values, 'line.Notes', task.notes);
    for (const row of lineStores.filter(item => item.task_id === task.id)) {
      const slot = typeof row.slot === 'number' ? row.slot : null;
      const prefix = slot ? `line.S${String(slot)} ` : `ref.${typeof row.code === 'string' ? row.code : ''}.`;
      if (slot) set(values, `line.Store ${String(slot)}`, row.code);
      for (const [key, value] of Object.entries(object(row.values))) set(values, `${prefix}${key}`, value);
    }
    for (const row of markets.filter(item => item.task_id === task.id)) {
      const prefix = `dist.${String(row.market_code)}.`;
      for (const [label, column] of Object.entries(DIST_COLUMNS)) set(values, `${prefix}${label}`, column === 'distributor_id' ? row.distributor : row[column]);
      for (const [key, value] of Object.entries(object(row.values))) set(values, `${prefix}${key}`, value);
      for (const label of ['Margin', 'Extra margin', 'Margin terms', 'Margin as written', 'Contacts as written']) {
        const column = label.toLowerCase().replaceAll(' ', '_');
        set(values, `${prefix}${label}`, row[column]);
      }
    }
    const install = installs.find(item => item.task_id === task.id);
    if (install) {
      for (const [label, column] of Object.entries(INSTALL_COLUMNS)) set(values, `install.${label}`, column === 'vendor_id' ? install.vendor : install[column]);
      for (const [key, value] of Object.entries(object(install.values))) set(values, `install.${key}`, value);
    }
    versions[String(task.key)] = Number(task.version);
    return { lineId: String(task.key), externalKey: typeof task.external_key === 'string' ? task.external_key : '', values };
  });
  return { lines, versions };
}

export async function prepareAgainstDatabase(db: Db, projectId: string, prepared: PreparedImport): Promise<PreparedDraft> {
  const existing = await loadExisting(db, projectId);
  return { prepared, plan: planReimport(existing.lines, prepared.lines), versions: existing.versions };
}

async function ensureBrand(client: pg.PoolClient, workspaceId: string, name: string, hostGroup: Value, source: Value): Promise<string> {
  const norm = matchKey(name);
  const { rows } = await client.query<{ id: string }>(
    `insert into brand (workspace_id, name, name_norm, host_group, source) values ($1, $2, $3, $4, $5)
     on conflict (workspace_id, name_norm) do update set name = excluded.name,
       host_group = coalesce(excluded.host_group, brand.host_group), source = coalesce(excluded.source, brand.source),
       deleted_at = null, version = brand.version + 1
     returning id`,
    [workspaceId, name, norm, hostGroup, source],
  );
  return String(rows[0]?.id);
}

async function ensureVendor(client: pg.PoolClient, workspaceId: string, name: string): Promise<string> {
  const norm = alnumKey(name);
  const { rows } = await client.query<{ id: string }>(
    `insert into vendor (workspace_id, name, name_norm, aliases) values ($1, $2, $3, array[$2])
     on conflict (workspace_id, name_norm) do update set aliases =
       (select array_agg(distinct x) from unnest(vendor.aliases || excluded.aliases) x), deleted_at = null,
       version = vendor.version + 1 returning id`,
    [workspaceId, name, norm],
  );
  return String(rows[0]?.id);
}

function lineValues(fields: Fields): Fields {
  const skip = /^(Line ID|Launch|Brand|Host group|External key|Notes|Source|Store \d+|S\d .*)$/;
  return Object.fromEntries(Object.entries(fields).filter(([key]) => !skip.test(key)));
}

function storeValues(fields: Fields, slot: number): Fields {
  const prefix = `S${String(slot)} `;
  return Object.fromEntries(
    Object.entries(fields)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]),
  );
}

async function upsertLineStore(client: pg.PoolClient, workspaceId: string, taskId: string, storeId: string, values: Fields, source: Value, userId: string) {
  const current = await client.query<{ values: JsonObject }>('select values from line_store where task_id = $1 and store_id = $2 for update', [
    taskId,
    storeId,
  ]);
  const merged = mergeValues(object(current.rows[0]?.values), values);
  await client.query(
    `insert into line_store (workspace_id, task_id, store_id, values, source, updated_by)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (task_id, store_id) do update set values = excluded.values, source = excluded.source,
       updated_by = excluded.updated_by, deleted_at = null, version = line_store.version + 1`,
    [workspaceId, taskId, storeId, JSON.stringify(merged), source, userId],
  );
}

async function upsertDistribution(client: pg.PoolClient, workspaceId: string, brandId: string, market: string, fields: Fields, source: Value) {
  const vendorName = typeof fields.Distributor === 'string' && fields.Distributor ? fields.Distributor : null;
  const vendorId = vendorName ? await ensureVendor(client, workspaceId, vendorName) : null;
  const core = new Set([...Object.keys(DIST_COLUMNS), 'Margin', 'Extra margin', 'Margin terms', 'Margin as written', 'Contacts as written', 'Source']);
  const custom = Object.fromEntries(Object.entries(fields).filter(([key]) => !core.has(key)));
  const { rows } = await client.query<{ id: string }>(
    `insert into brand_market (workspace_id, brand_id, market_code, distribution_status, distributor_id,
       distributor_as_written, exclusive, exclusive_months, registration_route, values, notes, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (brand_id, market_code) do update set distribution_status=excluded.distribution_status,
       distributor_id=excluded.distributor_id, distributor_as_written=excluded.distributor_as_written,
       exclusive=excluded.exclusive, exclusive_months=excluded.exclusive_months,
       registration_route=excluded.registration_route, values=brand_market.values || excluded.values,
       notes=excluded.notes, source=excluded.source, deleted_at=null, version=brand_market.version+1 returning id`,
    [
      workspaceId,
      brandId,
      market,
      fields['Distribution status'],
      vendorId,
      fields['Distributor as written'],
      fields.Exclusive,
      fields['Exclusive months'],
      fields['Registration route'],
      JSON.stringify(mergeValues({}, custom)),
      fields.Notes,
      source,
    ],
  );
  const marketId = String(rows[0]?.id);
  if (['Margin', 'Extra margin', 'Margin terms', 'Margin as written'].some(key => key in fields)) {
    await client.query(
      `insert into brand_market_margin (brand_market_id, workspace_id, margin, extra_margin, terms, as_written) values ($1,$2,$3,$4,$5,$6)
       on conflict (brand_market_id) do update set margin=excluded.margin, extra_margin=excluded.extra_margin,
         terms=excluded.terms, as_written=excluded.as_written, version=brand_market_margin.version+1`,
      [marketId, workspaceId, fields.Margin, fields['Extra margin'], fields['Margin terms'], fields['Margin as written']],
    );
  }
  if ('Contacts as written' in fields) {
    await client.query(
      `insert into brand_market_contacts (brand_market_id, workspace_id, contacts_as_written) values ($1,$2,$3)
       on conflict (brand_market_id) do update set contacts_as_written=excluded.contacts_as_written,
         version=brand_market_contacts.version+1`,
      [marketId, workspaceId, fields['Contacts as written']],
    );
  }
}

async function upsertInstall(client: pg.PoolClient, workspaceId: string, projectId: string, taskId: string, storeId: string, fields: Fields, source: Value) {
  const vendorName = typeof fields.Vendor === 'string' && fields.Vendor ? fields.Vendor : null;
  const vendorId = vendorName ? await ensureVendor(client, workspaceId, vendorName) : null;
  const current = await client.query<Row>('select * from install where task_id=$1 and store_id=$2 and deleted_at is null for update', [taskId, storeId]);
  const row = current.rows[0];
  const custom = Object.fromEntries(Object.entries(fields).filter(([key]) => !(key in INSTALL_COLUMNS) && key !== 'Store' && key !== 'Source'));
  const params = [
    workspaceId,
    projectId,
    taskId,
    storeId,
    fields['Host group'],
    vendorId,
    fields['Vendor as written'],
    fields.Brand,
    fields.Zone,
    fields['Fixture as written'],
    fields['Vendor pack'],
    fields['Install start'],
    fields['Install end'],
    fields['Install status'],
    fields.Contractor,
    fields['Delivery date'],
    fields['Delivery status'],
    fields['VM status'],
    fields['Wall perimeter'] == null ? null : fields['Wall perimeter'] === 'Yes',
    fields['Email sent'],
    fields['Email sent by'],
    JSON.stringify(mergeValues(object(row?.values), custom)),
    fields.Notes,
    source,
  ];
  if (!row) {
    await client.query(
      `insert into install (workspace_id,project_id,task_id,store_id,host_group,vendor_id,vendor_as_written,brand,
        zone_as_written,fixture_as_written,vendor_pack,install_start,install_end,install_status,contractor,delivery_date,
        delivery_status,vm_status,wall_perimeter,email_sent,email_sent_by,values,notes,source)
       values (${params.map((_value, index) => `$${String(index + 1)}`).join(',')})`,
      params,
    );
  } else {
    await client.query(
      `update install set host_group=$5,vendor_id=$6,vendor_as_written=$7,brand=$8,zone_as_written=$9,
        fixture_as_written=$10,vendor_pack=$11,install_start=$12,install_end=$13,install_status=$14,contractor=$15,
        delivery_date=$16,delivery_status=$17,vm_status=$18,wall_perimeter=$19,email_sent=$20,email_sent_by=$21,
        values=$22,notes=$23,source=$24,version=version+1 where id=$25`,
      [...params, row.id],
    );
  }
}

export interface CommitResult {
  summary: ReimportPlan['summary'];
  changedKeys: string[];
}

/** One short transaction: task, store, distribution, install, activity and job status succeed together. */
export async function commitPrepared(
  pool: pg.Pool,
  request: FastifyRequest,
  importId: string,
  expectedVersion: number,
  draft: PreparedDraft,
): Promise<CommitResult> {
  const workspace = workspaceOf(request);
  const userId = callerOf(request).userId;
  return tx(pool, async client => {
    const job = await client.query<{ project_id: string; status: string; summary: CommitResult | null; version: number }>(
      'select project_id, status, summary, version from import_job where id=$1 and workspace_id=$2 for update',
      [importId, workspace.id],
    );
    const currentJob = job.rows[0];
    if (!currentJob) throw new Error('Import draft disappeared before commit.');
    if (currentJob.status === 'committed' && currentJob.summary) return currentJob.summary;
    if (currentJob.version !== expectedVersion) {
      const error = new Error('The import choices changed after commit started.');
      error.name = 'ImportConflictError';
      throw error;
    }
    if (currentJob.status !== 'previewed') throw new Error(`Import is ${currentJob.status}, not previewed.`);
    const projectResult = await client.query<ProjectRow>('select id,key,launch_code,next_task_no from project where id=$1 and workspace_id=$2 for update', [
      currentJob.project_id,
      workspace.id,
    ]);
    const project = projectResult.rows[0];
    if (!project) throw new Error('The target launch no longer exists.');
    const stores = await projectStores(client, workspace.id, project.id);
    const storeByCode = new Map(stores.map(store => [matchKey(store.code), store]));
    const tasks = await client.query<Row>(
      `select t.*, b.name as brand from task t left join brand b on b.id=t.brand_id
        where t.project_id=$1 and t.kind='line' and t.deleted_at is null for update`,
      [project.id],
    );
    for (const task of tasks.rows) {
      const previewVersion = draft.versions[String(task.key)];
      if (previewVersion !== undefined && previewVersion !== Number(task.version)) {
        const error = new Error(`${String(task.key)} changed after this import was previewed.`);
        error.name = 'ImportConflictError';
        throw error;
      }
    }
    const byKey = new Map(tasks.rows.map(row => [String(row.key), row]));
    const byExternal = new Map(tasks.rows.filter(row => row.external_key).map(row => [matchKey(String(row.external_key)), row]));
    const usedKeys = new Set(byKey.keys());
    let next = project.next_task_no;
    const changedKeys: string[] = [];
    const rowTasks = new Map<number, string>();
    const importedRows: { line: ImportedLine; taskId: string; key: string; brandId: string }[] = [];

    for (const line of draft.prepared.lines) {
      const matched = (line.lineId ? byKey.get(line.lineId) : undefined) ?? byExternal.get(line.key);
      const planned = draft.plan.changes.find(change => change.rowNo === line.rowNo);
      if (matched && planned?.action === 'unchanged') {
        const taskId = String(matched.id);
        rowTasks.set(line.rowNo, taskId);
        importedRows.push({ line, taskId, key: String(matched.key), brandId: String(matched.brand_id) });
        continue;
      }
      const brandName = String(line.fields.Brand ?? '').trim();
      const brandId = await ensureBrand(client, workspace.id, brandName, line.fields['Host group'] ?? null, line.fields.Source ?? null);
      let key = matched ? String(matched.key) : '';
      if (!key) {
        const requested = line.lineId && new RegExp(`^${project.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(line.lineId) ? line.lineId : null;
        if (requested && !usedKeys.has(requested)) key = requested;
        else {
          do key = `${project.key}-${String(next++).padStart(3, '0')}`;
          while (usedKeys.has(key));
        }
        usedKeys.add(key);
      }
      const values = mergeValues(object(matched?.values), lineValues(line.fields));
      let taskId: string;
      let version: number;
      if (matched) {
        const updated = await client.query<{ id: string; version: number }>(
          `update task set title=$2,brand_id=$3,external_key=$4,values=$5,notes=$6,source=$7,updated_by=$8,version=version+1
            where id=$1 returning id,version`,
          [matched.id, brandName, brandId, line.fields['External key'], JSON.stringify(values), line.fields.Notes, line.fields.Source, userId],
        );
        taskId = String(updated.rows[0]?.id);
        version = Number(updated.rows[0]?.version);
      } else {
        const inserted = await client.query<{ id: string; version: number }>(
          `insert into task (workspace_id,project_id,kind,key,title,sort_order,brand_id,external_key,values,notes,source,created_by,updated_by)
           values ($1,$2,'line',$3,$4,coalesce((select max(sort_order)+1024 from task where project_id=$2),1024),$5,$6,$7,$8,$9,$10,$10)
           returning id,version`,
          [
            workspace.id,
            project.id,
            key,
            brandName,
            brandId,
            line.fields['External key'],
            JSON.stringify(values),
            line.fields.Notes,
            line.fields.Source,
            userId,
          ],
        );
        taskId = String(inserted.rows[0]?.id);
        version = Number(inserted.rows[0]?.version);
      }
      byKey.set(key, { ...(matched ?? {}), id: taskId, key, external_key: line.fields['External key'], values, version });
      if (line.fields['External key']) byExternal.set(matchKey(String(line.fields['External key'])), byKey.get(key) ?? {});
      rowTasks.set(line.rowNo, taskId);
      importedRows.push({ line, taskId, key, brandId });

      for (const store of stores.filter(item => item.slot !== null)) {
        const slot = Number(store.slot);
        if (line.fields[`Store ${String(slot)}`] === store.code) {
          await upsertLineStore(client, workspace.id, taskId, store.id, storeValues(line.fields, slot), line.fields.Source ?? null, userId);
        }
      }
      for (const [code, fields] of Object.entries(line.refFixtures)) {
        const store = storeByCode.get(matchKey(code));
        if (store) await upsertLineStore(client, workspace.id, taskId, store.id, fields, fields.Source ?? null, userId);
      }
      for (const [market, fields] of Object.entries(line.distribution))
        await upsertDistribution(client, workspace.id, brandId, market, fields, fields.Source ?? null);
      if (line.install) {
        const store = typeof line.install.Store === 'string' ? storeByCode.get(matchKey(line.install.Store)) : undefined;
        if (store) await upsertInstall(client, workspace.id, project.id, taskId, store.id, line.install, line.install.Source ?? null);
      }
      if (planned?.action !== 'unchanged') {
        changedKeys.push(key);
        await record(client, request, {
          verb: 'imported',
          entityKind: 'task',
          entityId: taskId,
          entityVersion: version,
          projectId: project.id,
          taskId,
          changes: planned?.fields.map(field => ({ field: field.path, from: field.from, to: field.to })),
          extra: importId,
        });
      }
    }
    for (const { line, taskId } of importedRows) {
      const primaryId = line.doubleOfRow === null ? null : (rowTasks.get(line.doubleOfRow) ?? null);
      await client.query('update task set double_of_id=$2,version=version+1 where id=$1 and double_of_id is distinct from $2::uuid', [taskId, primaryId]);
    }
    if (next !== project.next_task_no) await client.query('update project set next_task_no=$2,version=version+1 where id=$1', [project.id, next]);
    const result = { summary: draft.plan.summary, changedKeys };
    await client.query(`update import_job set status='committed', committed_at=now(), summary=$2,version=version+1 where id=$1`, [
      importId,
      JSON.stringify(result),
    ]);
    return result;
  });
}

export interface ExportData extends OrganisedRows {
  tables: Record<string, TableRow[]>;
  launch: string;
  stores: string[];
}

/** Database rows in the exact table/header vocabulary expected by the workbook engine. */
export async function loadExportData(db: Db, workspaceId: string, projectId: string): Promise<ExportData> {
  const project = await db.query<{ launch_code: string; key: string }>(
    'select launch_code,key from project where id=$1 and workspace_id=$2 and deleted_at is null',
    [projectId, workspaceId],
  );
  const launch = project.rows[0]?.launch_code ?? project.rows[0]?.key;
  if (!launch) throw new Error('The launch does not exist.');
  const stores = await projectStores(db, workspaceId, projectId);
  const existing = await loadExisting(db, projectId);
  const lines: TableRow[] = existing.lines.map(line => {
    const row: TableRow = {};
    for (const [path, value] of Object.entries(line.values)) if (path.startsWith('line.')) row[path.slice(5)] = value;
    return row;
  });
  const distribution: TableRow[] = [];
  for (const line of existing.lines) {
    for (const [path, value] of Object.entries(line.values)) {
      const match = /^dist\.([^.]+)\.(.+)$/.exec(path);
      if (!match?.[1] || !match[2]) continue;
      let row = distribution.find(item => item['Line ID'] === line.lineId && item.Market === match[1]);
      if (!row) {
        row = { 'Line ID': line.lineId, Brand: line.values['line.Brand'], Market: match[1] };
        distribution.push(row);
      }
      row[match[2]] = value;
    }
  }
  const installRows = await db.query<Row>(
    `select i.*,t.key as line_id,s.code as store,v.name as vendor from install i join task t on t.id=i.task_id
      join store s on s.id=i.store_id left join vendor v on v.id=i.vendor_id
      where i.workspace_id=$1 and i.project_id=$2 and i.deleted_at is null`,
    [workspaceId, projectId],
  );
  const installs: TableRow[] = installRows.rows.map(item => {
    const row: TableRow = { 'Line ID': item.line_id as string, Store: item.store as string };
    for (const [label, column] of Object.entries(INSTALL_COLUMNS)) row[label] = (column === 'vendor_id' ? item.vendor : item[column]) as Value;
    return { ...row, ...object(item.values) };
  });
  const brands = await db.query<Row>(
    `select distinct b.name,b.host_group from brand b join task t on t.brand_id=b.id
      where t.project_id=$1 and t.deleted_at is null order by b.name`,
    [projectId],
  );
  return {
    lines,
    distribution,
    installs,
    launch,
    stores: stores.filter(store => store.slot !== null).map(store => store.code),
    tables: {
      tblLines: lines,
      tblDistribution: distribution,
      tblInstalls: installs,
      tblStores: stores.map(store => ({ Code: store.code })),
      tblBrands: brands.rows.map(brand => ({ Brand: brand.name as string, 'Host group': brand.host_group as Value })),
    },
  };
}
