import { createHash, randomUUID } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { MultipartFile } from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { MANAGERS, seesContacts, seesMargins } from '../../access/policy.js';
import { tx, type Db } from '../../db/tx.js';
import { commitPrepared, loadExportData, prepareAgainstDatabase, projectStores, type PreparedDraft } from '../../excel/database.js';
import { CSV_SCOPES, installSchedule, toCsv, vendorPack, type CsvScope } from '../../excel/exports.js';
import { applyExceptionResolutions, prepareImport, type ExceptionDecision, type PreparedImport } from '../../excel/import.js';
import { detectLayout, type Layout } from '../../excel/layouts.js';
import { ImportError, LIMITS, readWorkbook, type Workbook } from '../../excel/xlsx-read.js';
import { fillWorkbook } from '../../excel/xlsx-write.js';
import { callerOf, workspaceOf } from '../context.js';
import { ifMatch, toApi, withEtag, type Json, type Row } from '../http.js';
import type { ApiOptions } from '../plugin.js';
import { ApiError, invalid, notFound } from '../problem.js';
import { record } from '../rows.js';
import { Id, Ws, WsId } from '../schemas.js';
import { readProject } from './projects.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CSV = 'text/csv; charset=utf-8';
const LayoutId = Type.Enum(['launch_tracker', 'avenues', 'organised', 'fixture_counts', 'custom']);
const StoreMap = Type.Record(Type.String({ pattern: '^[A-Z0-9]{1,8}$' }), Id, { maxProperties: 20 });
const Mapping = Type.Record(Type.String({ pattern: '^[A-Z]{1,3}$' }), Type.String({ minLength: 1, maxLength: 160 }), { maxProperties: 200 });
const JobParams = Type.Object({ ws: Type.String(), id: Id });

interface JobRow extends Row {
  id: string;
  workspace_id: string;
  project_id: string | null;
  file_id: string;
  file_name: string;
  blob_name: string;
  sheet: string | null;
  layout: Layout['id'] | 'fixture_counts' | 'custom' | null;
  mapping: Record<string, string>;
  store_map: Record<string, string>;
  status: string;
  summary: unknown;
  expires_at: Date;
  version: number;
}

function publicJob(row: JobRow, sheets?: ReturnType<typeof sheetSummary>): Row {
  const rendered = toApi(row);
  delete rendered.workspaceId;
  delete rendered.blobName;
  if (rendered.summary && typeof rendered.summary === 'object' && !Array.isArray(rendered.summary)) {
    rendered.summary = Object.fromEntries(Object.entries(rendered.summary as Record<string, unknown>).filter(([key]) => key !== 'previewVersions'));
  }
  if (sheets) rendered.sheets = sheets;
  return rendered;
}

async function readJob(db: Db, workspaceId: string, id: string, lock = false): Promise<JobRow> {
  const { rows } = await db.query<JobRow>(
    `select j.*, f.name as file_name, f.blob_name
       from import_job j join file f on f.id=j.file_id
      where j.id=$1 and j.workspace_id=$2 and (j.expires_at > now() or j.status in ('committed','cancelled')) ${lock ? 'for update of j' : ''}`,
    [id, workspaceId],
  );
  const row = rows[0];
  if (!row) throw notFound('This import draft');
  return row;
}

function conflict(row: JobRow): ApiError {
  return new ApiError(409, 'version_conflict', 'Someone else changed this import first. Reload it and try again.', { current: publicJob(row) });
}

function importState(detail: string): ApiError {
  return new ApiError(409, 'import_state', detail);
}

function asImportProblem(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof ImportError) {
    throw new ApiError(error.code === 'too_large' ? 413 : 422, error.code, error.message);
  }
  throw error;
}

const fileTooLarge = () => new ApiError(413, 'payload_too_large', 'The file is over 25 MiB. Remove unused sheets or images, then upload it again.');

async function filePart(request: FastifyRequest): Promise<MultipartFile> {
  try {
    const part = await request.file({ limits: { files: 1, fileSize: LIMITS.fileBytes, fields: 0, parts: 1 } });
    if (!part) throw new ApiError(400, 'bad_request', 'Choose one .xlsx file to import.');
    return part;
  } catch (error) {
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw fileTooLarge();
    throw error;
  }
}

async function workbookBytes(part: MultipartFile): Promise<Buffer> {
  if (!part.filename.toLowerCase().endsWith('.xlsx')) throw new ApiError(422, 'not_xlsx', new ImportError('not_xlsx').message);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const value of part.file as AsyncIterable<Uint8Array>) {
      const chunk = new Uint8Array(value);
      length += chunk.length;
      if (length > LIMITS.fileBytes) throw fileTooLarge();
      chunks.push(chunk);
    }
  } catch (error) {
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw fileTooLarge();
    throw error;
  }
  if (part.file.truncated) throw fileTooLarge();
  const bytes = Buffer.concat(chunks, length);
  if (bytes.length < 4 || !bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    throw new ApiError(422, 'not_xlsx', 'This file is not an .xlsx workbook. Export it as Excel Workbook (.xlsx), then upload that copy.');
  }
  return bytes;
}

function sheetSummary(workbook: Workbook) {
  return workbook.sheets
    .filter(sheet => !sheet.hidden)
    .map(sheet => {
      const found = detectLayout(sheet);
      return {
        name: sheet.name,
        rows: Math.max(0, sheet.lastRow - (found?.headerRow ?? 1)),
        detectedLayout: found?.layout.id ?? null,
      };
    });
}

async function blobBytes(options: ApiOptions, job: JobRow): Promise<Buffer> {
  if (!options.blobs) throw new ApiError(503, 'unavailable', 'Workbook storage is not configured. Ask an administrator to check Blob storage and try again.');
  try {
    return await options.blobs.getBlockBlobClient(job.blob_name).downloadToBuffer();
  } catch {
    throw new ApiError(503, 'unavailable', 'The uploaded workbook could not be read from Blob storage. Try again; if it keeps failing, upload it again.');
  }
}

function chosenLayout(workbook: Workbook, job: JobRow): { sheet: Workbook['sheets'][number]; layout: Layout; headerRow: number } {
  const sheet = workbook.sheets.find(item => item.name === job.sheet);
  if (!sheet) throw invalid([{ path: 'sheet', code: 'unknown_ref', message: 'That sheet is not in the uploaded workbook.' }]);
  const detected = detectLayout(sheet);
  if (!detected) throw invalid([{ path: 'layout', code: 'out_of_range', message: 'This sheet needs a column mapping before it can be previewed.' }]);
  if (job.layout !== 'custom' && job.layout !== detected.layout.id) {
    const fixed = detected.layout.id === job.layout ? detected : undefined;
    if (!fixed) throw invalid([{ path: 'layout', code: 'out_of_range', message: `This sheet is ${detected.layout.id}, not ${String(job.layout)}.` }]);
  }
  return { sheet, layout: detected.layout, headerRow: detected.headerRow };
}

function internalMapping(mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [column, target] of Object.entries(mapping)) {
    if (/^(line|dist|ref|install):|^(notes|skip)$/.test(target)) out[column] = target;
    else if (target === 'brand.name') out[column] = 'line:Brand';
    else throw invalid([{ path: `mapping.${column}`, code: 'unknown_field', message: `${target} is not an import target.` }]);
  }
  return out;
}

async function prepareContext(db: Db, request: FastifyRequest, job: JobRow) {
  if (!job.project_id) throw importState('Pick a launch before previewing this import.');
  const workspace = workspaceOf(request);
  const project = await readProject(db, request, job.project_id);
  if (project.kind !== 'launch') throw invalid([{ path: 'projectId', code: 'out_of_range', message: 'Workbook imports go into launch projects.' }]);
  const stores = await projectStores(db, workspace.id, job.project_id);
  const storeById = new Map(stores.map(store => [store.id, store]));
  const storeMap: Record<string, string> = {};
  for (const [group, id] of Object.entries(job.store_map)) {
    const store = storeById.get(id);
    if (!store) throw invalid([{ path: `storeMap.${group}`, code: 'unknown_ref', message: 'That store is not in this workspace.' }]);
    storeMap[group] = store.code;
  }
  const brands = await db.query<{ name: string }>('select name from brand where workspace_id=$1 and deleted_at is null order by name', [workspace.id]);
  const vendors = await db.query<{ name: string; aliases: string[] }>(
    'select name,aliases from vendor where workspace_id=$1 and deleted_at is null order by name',
    [workspace.id],
  );
  const reviewed = await db.query<{ field: string; original: string; stored_as: string }>(
    'select field,original,stored_as from import_normalisation where import_id=$1',
    [job.id],
  );
  return {
    launch: String(project.launch_code ?? project.key),
    storeMap,
    stores: stores.map(store => ({ code: store.code })),
    brands: brands.rows.map(row => row.name),
    vendors: vendors.rows,
    mapping: internalMapping(job.mapping),
    normalisations: Object.fromEntries(reviewed.rows.map(row => [`${row.field}\u0000${row.original}`, row.stored_as])),
    defaultYear: typeof project.due_date === 'string' ? Number(project.due_date.slice(0, 4)) : undefined,
  };
}

async function applyReviewedExceptions(db: Db, job: JobRow, prepared: PreparedImport): Promise<void> {
  const decisions = await db.query<{
    row_no: number;
    field: string | null;
    kind: ExceptionDecision['kind'];
    value: string | null;
    resolution: ExceptionDecision['resolution'];
  }>('select row_no,field,kind,value,resolution from import_exception where import_id=$1 and resolution is not null', [job.id]);
  applyExceptionResolutions(
    prepared,
    decisions.rows.map(item => ({ rowNo: item.row_no, field: item.field, kind: item.kind, value: item.value, resolution: item.resolution })),
  );
}

function removeRestricted(prepared: PreparedImport, request: FastifyRequest): void {
  const workspace = workspaceOf(request);
  const margin = seesMargins(workspace.settings, workspace.actor);
  const contacts = seesContacts(workspace.settings, workspace.actor);
  const restricted = [...(!margin ? ['Margin', 'Extra margin', 'Margin terms', 'Margin as written'] : []), ...(!contacts ? ['Contacts as written'] : [])];
  const seen = new Set<string>();
  for (const line of prepared.lines) {
    for (const [market, fields] of Object.entries(line.distribution)) {
      for (const field of restricted) {
        if (!(field in fields)) continue;
        const key = `${market}:${field}`;
        if (seen.has(key)) continue;
        seen.add(key);
        prepared.exceptions.push({
          sheet: prepared.sheet,
          rowNo: line.rowNo,
          field: `${field} (${market})`,
          kind: 'conflict',
          value: null,
          message: `${field} was not imported because your role may not see it.`,
        });
      }
      line.distribution[market] = Object.fromEntries(Object.entries(fields).filter(([field]) => !restricted.includes(field)));
    }
  }
}

function summaryOf(draft: PreparedDraft) {
  const kinds = new Set(draft.prepared.exceptions.map(item => `${item.kind}\u0000${item.value ?? ''}`));
  return {
    lines: draft.plan.summary,
    brands: { create: [...kinds].filter(key => key.startsWith('unknown_brand\u0000')).length, update: 0 },
    vendors: { create: [...kinds].filter(key => key.startsWith('unknown_vendor\u0000')).length, merge: 0 },
    exceptions: draft.prepared.exceptions.length,
    normalised: draft.prepared.normalisations.length,
  };
}

async function savePreview(client: pg.PoolClient, job: JobRow, draft: PreparedDraft) {
  const old = await client.query<{ sheet: string; row_no: number; field: string | null; kind: string; value: string | null; resolution: Json }>(
    'select sheet,row_no,field,kind,value,resolution from import_exception where import_id=$1 and resolution is not null',
    [job.id],
  );
  const resolution = new Map(old.rows.map(row => [[row.sheet, row.row_no, row.field, row.kind, row.value].join('\u0000'), row.resolution]));
  await client.query('delete from import_exception where import_id=$1', [job.id]);
  await client.query('delete from import_normalisation where import_id=$1', [job.id]);
  for (const item of draft.prepared.normalisations) {
    await client.query('insert into import_normalisation (import_id,field,original,stored_as,cells) values ($1,$2,$3,$4,$5)', [
      job.id,
      item.field,
      item.original,
      item.storedAs,
      item.cells,
    ]);
  }
  for (const item of draft.prepared.exceptions) {
    const key = [item.sheet, item.rowNo, item.field, item.kind, item.value].join('\u0000');
    const fallback =
      item.kind === 'unknown_brand' || item.kind === 'unknown_vendor' || item.kind === 'duplicate'
        ? { action: 'create' }
        : item.kind === 'double_linked'
          ? { action: 'map' }
          : { action: 'keep_as_note' };
    await client.query('insert into import_exception (import_id,sheet,row_no,field,kind,value,message,resolution) values ($1,$2,$3,$4,$5,$6,$7,$8)', [
      job.id,
      item.sheet,
      item.rowNo,
      item.field,
      item.kind,
      item.value,
      item.message,
      JSON.stringify(resolution.get(key) ?? fallback),
    ]);
  }
  const result = await client.query<JobRow>(`update import_job set status='previewed', summary=$2, version=version+1 where id=$1 returning *`, [
    job.id,
    JSON.stringify({ ...summaryOf(draft), previewVersions: draft.versions }),
  ]);
  return result.rows[0];
}

function contentName(reply: { header: (name: string, value: string) => unknown }, name: string, type: string) {
  reply.header('content-type', type);
  reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  reply.header('x-content-type-options', 'nosniff');
  reply.header('cache-control', 'private, no-store');
}

async function templatePath(): Promise<URL> {
  const installed = new URL('../../../templates/launch-workbook/launch-workbook-template.xlsx', import.meta.url);
  const checkout = new URL('../../../../templates/launch-workbook/launch-workbook-template.xlsx', import.meta.url);
  try {
    await access(installed);
    return installed;
  } catch {
    return checkout;
  }
}

function scrubExport(data: Awaited<ReturnType<typeof loadExportData>>, request: FastifyRequest) {
  const workspace = workspaceOf(request);
  if (!seesMargins(workspace.settings, workspace.actor)) {
    for (const row of data.distribution) for (const field of ['Margin', 'Extra margin', 'Margin terms', 'Margin as written']) row[field] = null;
  }
  if (!seesContacts(workspace.settings, workspace.actor)) for (const row of data.distribution) row['Contacts as written'] = null;
}

function csvHeaders(scope: CsvScope, request: FastifyRequest): readonly string[] {
  if (scope !== 'distribution') return CSV_SCOPES[scope];
  const workspace = workspaceOf(request);
  const hidden = new Set<string>();
  if (!seesMargins(workspace.settings, workspace.actor)) for (const field of ['Margin', 'Extra margin', 'Margin terms', 'Margin as written']) hidden.add(field);
  if (!seesContacts(workspace.settings, workspace.actor)) hidden.add('Contacts as written');
  return CSV_SCOPES.distribution.filter(field => !hidden.has(field));
}

export function imports(plain: FastifyInstance, options: ApiOptions, done: () => void) {
  const { pool } = options;
  const app = plain.withTypeProvider<TypeBoxTypeProvider>();

  app.post('/imports', { config: { access: MANAGERS }, schema: { params: Ws } }, async (request, reply) => {
    if (!options.blobs) throw new ApiError(503, 'unavailable', 'Workbook storage is not configured. Ask an administrator to check Blob storage and try again.');
    const part = await filePart(request);
    const bytes = await workbookBytes(part);
    let workbook: Workbook;
    try {
      workbook = readWorkbook(bytes);
    } catch (error) {
      asImportProblem(error);
    }
    const workspace = workspaceOf(request);
    const fileId = randomUUID();
    const importId = randomUUID();
    const blobName = `imports/${workspace.id}/${fileId}`;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const sheets = sheetSummary(workbook);
    try {
      await options.blobs.getBlockBlobClient(blobName).uploadData(bytes, { blobHTTPHeaders: { blobContentType: XLSX } });
      const row = await tx(pool, async client => {
        await client.query(
          `insert into file (id,workspace_id,name,content_type,size_bytes,sha256,blob_container,blob_name,uploaded_by)
           values ($1,$2,$3,$4,$5,$6,'imports',$7,$8)`,
          [fileId, workspace.id, part.filename, XLSX, bytes.length, sha256, blobName, callerOf(request).userId],
        );
        const inserted = await client.query<JobRow>('insert into import_job (id,workspace_id,file_id,created_by) values ($1,$2,$3,$4) returning *', [
          importId,
          workspace.id,
          fileId,
          callerOf(request).userId,
        ]);
        return { ...(inserted.rows[0] ?? {}), file_name: part.filename, blob_name: blobName } as JobRow;
      });
      return await reply
        .code(201)
        .header('location', `/api/v1/w/${workspace.slug}/imports/${importId}`)
        .header('etag', `"${String(row.version)}"`)
        .send(publicJob(row, sheets));
    } catch (error) {
      await options.blobs
        .getBlockBlobClient(blobName)
        .deleteIfExists()
        .catch(() => undefined);
      throw error;
    }
  });

  app.get('/imports/:id', { config: { access: MANAGERS }, schema: { params: JobParams } }, async (request, reply) => {
    const job = await readJob(pool, workspaceOf(request).id, request.params.id);
    let workbook: Workbook;
    try {
      workbook = readWorkbook(await blobBytes(options, job));
    } catch (error) {
      asImportProblem(error);
    }
    return withEtag(reply, publicJob(job, sheetSummary(workbook)));
  });

  app.patch(
    '/imports/:id',
    {
      config: { access: MANAGERS },
      schema: {
        params: JobParams,
        body: Type.Object({ sheet: Type.String({ minLength: 1, maxLength: 255 }), layout: LayoutId, projectId: Id, storeMap: StoreMap, mapping: Mapping }),
      },
    },
    async (request, reply) => {
      const workspace = workspaceOf(request);
      const version = ifMatch(request);
      await readProject(pool, request, request.body.projectId);
      const current = await readJob(pool, workspace.id, request.params.id);
      let workbook: Workbook;
      try {
        workbook = readWorkbook(await blobBytes(options, current));
      } catch (error) {
        asImportProblem(error);
      }
      if (!workbook.sheets.some(item => item.name === request.body.sheet))
        throw invalid([{ path: 'sheet', code: 'unknown_ref', message: 'That sheet is not in the uploaded workbook.' }]);
      const stores = await projectStores(pool, workspace.id, request.body.projectId);
      const allowed = new Set(stores.map(store => store.id));
      const missing = Object.entries(request.body.storeMap).filter(([, id]) => !allowed.has(id));
      if (missing.length)
        throw invalid(missing.map(([group]) => ({ path: `storeMap.${group}`, code: 'unknown_ref', message: 'That store is not in this workspace.' })));
      const row = await tx(pool, async client => {
        const locked = await readJob(client, workspace.id, request.params.id, true);
        if (locked.version !== version) throw conflict(locked);
        if (['committed', 'cancelled'].includes(locked.status)) throw importState(`This import is already ${locked.status}. Start a new import to change it.`);
        const changed = await client.query<JobRow>(
          `update import_job set sheet=$2,layout=$3,project_id=$4,store_map=$5,mapping=$6,status='mapped',summary=null,version=version+1 where id=$1 returning *`,
          [
            locked.id,
            request.body.sheet,
            request.body.layout,
            request.body.projectId,
            JSON.stringify(request.body.storeMap),
            JSON.stringify(request.body.mapping),
          ],
        );
        return { ...(changed.rows[0] ?? {}), file_name: locked.file_name, blob_name: locked.blob_name } as JobRow;
      });
      return withEtag(reply, publicJob(row));
    },
  );

  app.post('/imports/:id/preview', { config: { access: MANAGERS }, schema: { params: JobParams } }, async (request, reply) => {
    const workspace = workspaceOf(request);
    const version = ifMatch(request);
    const job = await readJob(pool, workspace.id, request.params.id);
    if (job.version !== version) throw conflict(job);
    if (!['mapped', 'previewed'].includes(job.status)) throw importState('Pick the sheet, launch and stores before previewing this import.');
    const bytes = await blobBytes(options, job);
    let workbook: Workbook;
    try {
      workbook = readWorkbook(bytes);
    } catch (error) {
      asImportProblem(error);
    }
    const chosen = chosenLayout(workbook, job);
    const context = await prepareContext(pool, request, job);
    const prepared = prepareImport(chosen.sheet, chosen.layout, chosen.headerRow, context);
    await applyReviewedExceptions(pool, job, prepared);
    removeRestricted(prepared, request);
    const draft = await prepareAgainstDatabase(pool, String(job.project_id), prepared);
    const stored = await tx(pool, async client => {
      const current = await readJob(client, workspace.id, job.id, true);
      if (current.version !== version) throw conflict(current);
      return savePreview(client, current, draft);
    });
    const normalisations = await pool.query<Row>(
      'select id,field,original,stored_as,cells from import_normalisation where import_id=$1 order by field,cells desc,original',
      [job.id],
    );
    const summary = summaryOf(draft);
    return reply.header('etag', `"${String(stored?.version)}"`).send({
      import: publicJob({ ...(stored ?? {}), file_name: job.file_name, blob_name: job.blob_name } as JobRow),
      summary,
      normalisations: normalisations.rows.map(toApi),
      changes: draft.plan.changes.filter(change => change.action !== 'unchanged').slice(0, 2_000),
      exceptionsUrl: `/api/v1/w/${workspace.slug}/imports/${job.id}/exceptions`,
    });
  });

  app.get('/imports/:id/normalisations', { config: { access: MANAGERS }, schema: { params: JobParams } }, async request => {
    const job = await readJob(pool, workspaceOf(request).id, request.params.id);
    const rows = await pool.query<Row>(
      'select id,field,original,stored_as,cells from import_normalisation where import_id=$1 order by field,cells desc,original',
      [job.id],
    );
    return { items: rows.rows.map(toApi), nextCursor: null };
  });

  app.patch(
    '/imports/:id/normalisations/:normalisationId',
    {
      config: { access: MANAGERS },
      schema: {
        params: Type.Object({ ws: Type.String(), id: Id, normalisationId: Id }),
        body: Type.Object({ storedAs: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
      },
    },
    async request => {
      const job = await readJob(pool, workspaceOf(request).id, request.params.id);
      if (['committed', 'cancelled'].includes(job.status)) throw importState(`This import is already ${job.status}.`);
      const result = await pool.query<Row>(
        `update import_normalisation set stored_as=$3 where import_id=$1 and id=$2 returning id,field,original,stored_as,cells`,
        [job.id, request.params.normalisationId, request.body.storedAs],
      );
      if (!result.rows[0]) throw notFound('This normalisation');
      await pool.query(`update import_job set status='mapped',summary=null,version=version+1 where id=$1`, [job.id]);
      return toApi(result.rows[0]);
    },
  );

  app.get(
    '/imports/:id/exceptions',
    {
      config: { access: MANAGERS },
      schema: { params: JobParams, querystring: Type.Object({ kind: Type.Optional(Type.String({ maxLength: 40 })) }, { additionalProperties: false }) },
    },
    async request => {
      const job = await readJob(pool, workspaceOf(request).id, request.params.id);
      const rows = await pool.query<Row>('select * from import_exception where import_id=$1 and ($2::text is null or kind=$2) order by row_no,id', [
        job.id,
        request.query.kind ?? null,
      ]);
      return { items: rows.rows.map(toApi), nextCursor: null };
    },
  );

  app.patch(
    '/imports/:id/exceptions/:exceptionId',
    {
      config: { access: MANAGERS },
      schema: {
        params: Type.Object({ ws: Type.String(), id: Id, exceptionId: Type.Integer({ minimum: 1 }) }),
        body: Type.Object(
          { resolution: Type.Object({ action: Type.Enum(['map', 'skip', 'keep_as_note', 'create']), to: Type.Optional(Type.String({ maxLength: 200 })) }) },
          { additionalProperties: false },
        ),
      },
    },
    async request => {
      const job = await readJob(pool, workspaceOf(request).id, request.params.id);
      if (['committed', 'cancelled'].includes(job.status)) throw importState(`This import is already ${job.status}.`);
      if (request.body.resolution.action === 'map' && !request.body.resolution.to?.trim())
        throw invalid([{ path: 'resolution.to', code: 'required', message: 'Pick the value this should map to.' }]);
      const result = await pool.query<Row>('update import_exception set resolution=$3 where import_id=$1 and id=$2 returning *', [
        job.id,
        request.params.exceptionId,
        JSON.stringify(request.body.resolution),
      ]);
      if (!result.rows[0]) throw notFound('This exception');
      await pool.query(`update import_job set status='mapped',summary=null,version=version+1 where id=$1`, [job.id]);
      return toApi(result.rows[0]);
    },
  );

  app.post('/imports/:id/commit', { config: { access: MANAGERS }, schema: { params: JobParams } }, async (request, reply) => {
    const job = await readJob(pool, workspaceOf(request).id, request.params.id);
    const version = ifMatch(request);
    if (job.status === 'committed') return withEtag(reply, publicJob(job));
    if (job.version !== version) throw conflict(job);
    if (job.status !== 'previewed') throw importState('Preview this import again before committing it.');
    let workbook: Workbook;
    try {
      workbook = readWorkbook(await blobBytes(options, job));
    } catch (error) {
      asImportProblem(error);
    }
    const chosen = chosenLayout(workbook, job);
    const context = await prepareContext(pool, request, job);
    const prepared = prepareImport(chosen.sheet, chosen.layout, chosen.headerRow, context);
    await applyReviewedExceptions(pool, job, prepared);
    removeRestricted(prepared, request);
    const draft = await prepareAgainstDatabase(pool, String(job.project_id), prepared);
    const savedSummary = job.summary && typeof job.summary === 'object' && !Array.isArray(job.summary) ? (job.summary as Record<string, unknown>) : {};
    const previewVersions = savedSummary.previewVersions;
    if (previewVersions && typeof previewVersions === 'object' && !Array.isArray(previewVersions)) {
      draft.versions = Object.fromEntries(
        Object.entries(previewVersions as Record<string, unknown>).filter((entry): entry is [string, number] => Number.isInteger(entry[1])),
      );
    }
    try {
      await commitPrepared(pool, request, job.id, version, draft);
    } catch (error) {
      if ((error as Error).name === 'ImportConflictError') {
        throw new ApiError(409, 'version_conflict', `${(error as Error).message} Preview again so the newer values are not overwritten.`);
      }
      // commitPrepared owns one database transaction. Its rollback leaves this
      // preview and version intact, so the caller can safely press Commit again.
      throw error;
    }
    return withEtag(reply, publicJob(await readJob(pool, workspaceOf(request).id, job.id)));
  });

  app.post('/imports/:id/cancel', { config: { access: MANAGERS }, schema: { params: JobParams } }, async (request, reply) => {
    const workspace = workspaceOf(request);
    const version = ifMatch(request);
    const job = await tx(pool, async client => {
      const current = await readJob(client, workspace.id, request.params.id, true);
      if (current.version !== version) throw conflict(current);
      if (current.status === 'committed') throw importState('A committed import cannot be cancelled.');
      const changed = await client.query<JobRow>(`update import_job set status='cancelled',version=version+1 where id=$1 returning *`, [current.id]);
      await client.query('update file set deleted_at=now() where id=$1 and deleted_at is null', [current.file_id]);
      return { ...(changed.rows[0] ?? {}), file_name: current.file_name, blob_name: current.blob_name } as JobRow;
    });
    await options.blobs
      ?.getBlockBlobClient(job.blob_name)
      .deleteIfExists()
      .catch(() => undefined);
    return withEtag(reply, publicJob(job));
  });

  app.get(
    '/projects/:id/export',
    {
      config: { access: 'editor' },
      schema: {
        params: WsId,
        querystring: Type.Object(
          { format: Type.Enum(['workbook', 'csv']), scope: Type.Optional(Type.Enum(['lines', 'distribution', 'installs'])) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      await readProject(pool, request, request.params.id);
      const data = await loadExportData(pool, workspaceOf(request).id, request.params.id);
      scrubExport(data, request);
      let bytes: Uint8Array | string;
      let name: string;
      let type: string;
      if (request.query.format === 'workbook') {
        bytes = fillWorkbook(await readFile(await templatePath()), { tables: data.tables, dashboard: { launch: data.launch, stores: data.stores } });
        name = `${data.launch}-organised.xlsx`;
        type = XLSX;
      } else {
        const scope: CsvScope = request.query.scope ?? 'lines';
        bytes = toCsv(csvHeaders(scope, request), data[scope]);
        name = `${data.launch}-${scope}.csv`;
        type = CSV;
      }
      await record(pool, request, { verb: 'exported', entityKind: 'project', entityId: request.params.id, projectId: request.params.id, extra: name });
      contentName(reply, name, type);
      return reply.send(Buffer.from(bytes));
    },
  );

  app.get(
    '/projects/:id/export/vendor-pack',
    { config: { access: 'editor' }, schema: { params: WsId, querystring: Type.Object({ vendorId: Id }, { additionalProperties: false }) } },
    async (request, reply) => {
      await readProject(pool, request, request.params.id);
      const vendor = await pool.query<{ name: string }>('select name from vendor where id=$1 and workspace_id=$2 and deleted_at is null', [
        request.query.vendorId,
        workspaceOf(request).id,
      ]);
      if (!vendor.rows[0]) throw notFound('This vendor');
      const data = await loadExportData(pool, workspaceOf(request).id, request.params.id);
      scrubExport(data, request);
      const name = `${data.launch}-${vendor.rows[0].name}-vendor-pack.xlsx`;
      await record(pool, request, { verb: 'exported', entityKind: 'project', entityId: request.params.id, projectId: request.params.id, extra: name });
      contentName(reply, name, XLSX);
      return reply.send(Buffer.from(vendorPack(vendor.rows[0].name, data)));
    },
  );

  app.get(
    '/projects/:id/export/install-schedule',
    { config: { access: 'editor' }, schema: { params: WsId, querystring: Type.Object({ storeId: Id }, { additionalProperties: false }) } },
    async (request, reply) => {
      await readProject(pool, request, request.params.id);
      const store = await pool.query<{ code: string }>('select code from store where id=$1 and workspace_id=$2 and deleted_at is null', [
        request.query.storeId,
        workspaceOf(request).id,
      ]);
      if (!store.rows[0]) throw notFound('This store');
      const data = await loadExportData(pool, workspaceOf(request).id, request.params.id);
      scrubExport(data, request);
      const name = `${data.launch}-${store.rows[0].code}-install-schedule.xlsx`;
      await record(pool, request, { verb: 'exported', entityKind: 'project', entityId: request.params.id, projectId: request.params.id, extra: name });
      contentName(reply, name, XLSX);
      return reply.send(Buffer.from(installSchedule(store.rows[0].code, data)));
    },
  );

  done();
}
