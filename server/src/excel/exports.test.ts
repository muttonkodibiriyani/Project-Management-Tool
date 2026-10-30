import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { TEMPLATE } from '../testing/xlsx.js';
import { CSV_SCOPES, installSchedule, toCsv, vendorPack, type OrganisedRows } from './exports.js';
import { flatten, planReimport, prepareImport } from './import.js';
import { detectLayout } from './layouts.js';
import { readWorkbook, type Sheet } from './xlsx-read.js';
import { fillWorkbook, formulaLike, type FillInput } from './xlsx-write.js';

// Synthetic rows only.
const ROWS: OrganisedRows = {
  lines: [
    {
      'Line ID': 'L-1',
      Launch: 'TEST-LAUNCH',
      Zone: 'Body',
      Brand: 'Brand Alpha',
      'External key': 'Body Brand Alpha',
      'Brand code': 'Purple',
      'Store 1': 'SA',
      'S1 Listing': 'Yes',
      'S1 Fixture as written': 'GONDOLA 4FT',
      'S1 Fixture type': 'Gondola',
      'S1 Width ft': 4,
      'Store 2': 'SB',
      'S2 Fixture type': 'Wall',
      Comments: '=HYPERLINK("http://example.invalid","click")',
      Notes: '@SUM(A1)',
    },
    {
      'Line ID': 'L-2',
      Launch: 'TEST-LAUNCH',
      Zone: 'Fragrance',
      Brand: 'Brand Beta',
      'External key': 'Fragrance Brand Beta',
      'Store 1': 'SA',
      'S1 Listing': 'TBC',
      Comments: '+1 555 0100',
    },
  ],
  distribution: [
    {
      'Line ID': 'L-1',
      Brand: 'Brand Alpha',
      Market: 'QAT',
      'Distribution status': 'Distributor',
      Distributor: 'Vendor One',
      Margin: 0.3,
      'Extra margin': 0.05,
    },
    { 'Line ID': 'L-2', Brand: 'Brand Beta', Market: 'QAT', 'Distribution status': 'Distributor', Distributor: 'Vendor Two', Margin: 0.25 },
  ],
  installs: [
    {
      'Line ID': 'L-1',
      Store: 'SA',
      Brand: 'Brand Alpha',
      Vendor: 'Vendor One',
      'Install start': '2026-11-04',
      'Install status': 'Scheduled',
      'Delivery date': '2026-11-01',
    },
    { 'Line ID': 'L-2', Store: 'SA', Brand: 'Brand Beta', Vendor: 'Vendor Two', 'Install status': 'TBC', Notes: '-check with mall' },
    { 'Line ID': 'L-1', Store: 'SB', Brand: 'Brand Alpha', Vendor: 'Vendor One', 'Install start': '2026-11-10' },
  ],
};

const INPUT: FillInput = {
  tables: {
    tblLines: ROWS.lines,
    tblDistribution: ROWS.distribution,
    tblInstalls: ROWS.installs,
    tblStores: [{ Code: 'SA' }, { Code: 'SB' }],
    tblBrands: [{ Brand: 'Brand Alpha' }, { Brand: 'Brand Beta' }],
  },
  dashboard: { launch: 'TEST-LAUNCH', stores: ['SA', 'SB'] },
};

function filled(): { bytes: Uint8Array; parts: Record<string, string> } {
  const bytes = fillWorkbook(readFileSync(TEMPLATE), INPUT);
  const parts = Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));
  return { bytes, parts };
}

function sheet(bytes: Uint8Array, name: string): Sheet {
  const s = readWorkbook(bytes).sheets.find(x => x.name === name);
  assert.ok(s, `no sheet ${name}`);
  return s;
}

/** A read row with empty cells as undefined, for deepEqual. */
function dense(row: Sheet['rows'][number]): unknown[] {
  return Array.from(row ?? [], v => v);
}

function part(parts: Record<string, string>, path: string): string {
  const p = parts[path];
  assert.ok(p !== undefined, `no part ${path}`);
  return p;
}

test('the organised workbook is the template filled in: tables, drop-downs and colours cover every row', () => {
  const { bytes, parts } = filled();
  const lines = sheet(bytes, 'Lines');
  assert.equal(lines.rows[4]?.[0], 'L-1');
  assert.equal(lines.rows[5]?.[11], 'Brand Beta');
  assert.equal(lines.lastRow, 6);

  const linesXml = part(parts, 'xl/worksheets/sheet2.xml');
  assert.match(part(parts, 'xl/tables/table1.xml'), /<table [^>]*ref="A4:BR6"/);
  assert.match(part(parts, 'xl/tables/table1.xml'), /<autoFilter ref="A4:BR6"/);
  assert.match(linesXml, /<dataValidation sqref="D5:D6"[^>]*>[^]*?<formula1>lst_Zone<\/formula1>/);
  assert.match(linesXml, /<conditionalFormatting sqref="J5:J6 L5:L6">/);
  assert.match(linesXml, /<dimension ref="A1:BR6"\/>/);

  const installs = sheet(bytes, 'Installs & deliveries');
  assert.deepEqual(installs.rows[4]?.[10], { date: '2026-11-04' }, 'dates are real Excel dates');
  const distribution = part(parts, 'xl/worksheets/sheet4.xml');
  const percentStyle = /<c r="H5" s="(\d+)"><v>0.3<\/v><\/c>/.exec(distribution)?.[1];
  assert.ok(percentStyle, 'margin written as a number');
  const styles = part(parts, 'xl/styles.xml');
  const cellXfs = [...(/<cellXfs[^>]*>([^]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '').matchAll(/<xf\b[^>]*?(?:\/>|>[^]*?<\/xf>)/g)].map(m => m[0]);
  const format = /numFmtId="(\d+)"/.exec(cellXfs[Number(percentStyle)] ?? '')?.[1];
  assert.match(styles, new RegExp(`numFmtId="${String(format)}" formatCode="0.0%"`), 'margins show as percentages');

  const dashboard = sheet(bytes, 'Dashboard');
  assert.equal(dashboard.rows[3]?.[1], 'TEST-LAUNCH');
  assert.equal(dashboard.rows[4]?.[2], 'SB');
  assert.equal(sheet(bytes, 'Lists').rows[4]?.[0], 'Yes', 'value lists are kept');
});

test('no exported cell is a formula, and formula-like text is stored as text', () => {
  const { bytes, parts } = filled();
  for (let n = 2; n <= 9; n++) assert.doesNotMatch(part(parts, `xl/worksheets/sheet${String(n)}.xml`), /<f>/, `sheet${String(n)}`);
  const styles = part(parts, 'xl/styles.xml');
  const xfCount = Number(/<cellXfs count="(\d+)"/.exec(styles)?.[1]);
  const textStyle = String(xfCount - 1);
  assert.match(styles, /<xf [^>]*quotePrefix="1"\/><\/cellXfs>/);
  const linesXml = part(parts, 'xl/worksheets/sheet2.xml');
  for (const text of ['=HYPERLINK', '@SUM', '+1 555']) {
    const c = new RegExp(`<c r="[A-Z]+\\d+"( s="\\d+")? t="inlineStr"><is><t>${text.replace(/[+]/g, '\\+')}`).exec(linesXml);
    assert.ok(c, text);
    assert.equal(c[1], ` s="${textStyle}"`, `${text} is marked as text`);
  }
  const read = sheet(bytes, 'Lines');
  assert.equal(read.rows[4]?.[(read.rows[3] ?? []).indexOf('Comments')], '=HYPERLINK("http://example.invalid","click")');
});

test('the filled workbook re-imports as the organised layout without changes', () => {
  const { bytes } = filled();
  const lines = sheet(bytes, 'Lines');
  const detected = detectLayout(lines);
  assert.equal(detected?.layout.id, 'organised');
  assert.ok(detected);
  const ctx = { launch: 'TEST-LAUNCH', storeMap: {}, stores: [{ code: 'SA' }, { code: 'SB' }], brands: ['Brand Alpha', 'Brand Beta'] };
  const first = prepareImport(lines, detected.layout, detected.headerRow, ctx);
  assert.deepEqual(
    first.lines.map(l => l.key),
    ['L-1', 'L-2'],
  );
  assert.deepEqual(first.exceptions, []);
  const existing = first.lines.map(l => ({ lineId: String(l.lineId), externalKey: String(l.fields['External key']), values: flatten(l) }));
  const again = prepareImport(lines, detected.layout, detected.headerRow, ctx);
  assert.deepEqual(planReimport(existing, again.lines).summary, { create: 0, update: 0, unchanged: 2, notInFile: 0 });
});

test('unknown tables and columns are refused', () => {
  const template = readFileSync(TEMPLATE);
  assert.throws(() => fillWorkbook(template, { tables: { tblNope: [{}] } }), /no table tblNope/);
  assert.throws(() => fillWorkbook(template, { tables: { tblLines: [{ Margin: 1 }] } }), /tblLines has no column Margin/);
});

test('CSV is UTF-8 with a BOM, quoted where needed, and never starts a cell with a formula character', () => {
  const csv = toCsv(CSV_SCOPES.installs, ROWS.installs);
  assert.ok(csv.startsWith('﻿Line ID,Store,'));
  assert.ok(csv.endsWith('\r\n'));
  assert.match(csv, /,'-check with mall,\r\n/);
  assert.equal(toCsv(['a', 'b', 'c', 'd'], [{ a: '=1+1', b: 'x, "y"', c: -2, d: '@cmd' }]), '﻿a,b,c,d\r\n\'=1+1,"x, ""y""",-2,\'@cmd\r\n');
  for (const s of ['=', '+', '-', '@', '\tx', '\rx']) assert.ok(formulaLike(s), JSON.stringify(s));
  assert.ok(!formulaLike('Brand Alpha'));
});

test('a vendor pack lists the vendor’s brands with the fixture and dates at each store', () => {
  const pack = readWorkbook(vendorPack('VENDOR ONE', ROWS)).sheets[0];
  assert.ok(pack);
  assert.equal(pack.name, 'Vendor pack VENDOR ONE');
  assert.deepEqual(pack.rows[0]?.slice(0, 4), ['Brand', 'Zone', 'Store', 'Fixture type']);
  assert.equal(pack.lastRow, 3);
  assert.deepEqual(dense(pack.rows[1]), [
    'Brand Alpha',
    'Body',
    'SA',
    'Gondola',
    4,
    undefined,
    undefined,
    'GONDOLA 4FT',
    { date: '2026-11-04' },
    undefined,
    { date: '2026-11-01' },
  ]);
  assert.deepEqual(pack.rows[2]?.slice(0, 4), ['Brand Alpha', 'Body', 'SB', 'Wall']);
  assert.equal(readWorkbook(vendorPack('A/B: Vendor', ROWS)).sheets[0]?.name, 'Vendor pack A B  Vendor');
});

test('an install schedule lists one store’s installs, dated ones first', () => {
  const schedule = readWorkbook(installSchedule('sa', ROWS)).sheets[0];
  assert.ok(schedule);
  assert.equal(schedule.lastRow, 3);
  assert.deepEqual(dense(schedule.rows[1]).slice(0, 5), [{ date: '2026-11-04' }, undefined, 'Scheduled', 'Brand Alpha', 'Body']);
  assert.deepEqual(schedule.rows[2]?.slice(2, 5), ['TBC', 'Brand Beta', 'Fragrance']);
  assert.equal(schedule.rows[2][12], '-check with mall');
});
