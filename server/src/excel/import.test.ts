import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildXlsx, rowAt, type TestCell } from '../testing/xlsx.js';
import { MappingError, flatten, planReimport, prepareImport, usedGroups, type ExistingLine, type ImportContext, type ImportedLine } from './import.js';
import { KNOWN_LAYOUTS, detectLayout } from './layouts.js';
import { readWorkbook, type Sheet } from './xlsx-read.js';

// Synthetic workbooks only: every brand, vendor, store and person here is made up.

function headerRow(layoutId: string): TestCell[] {
  const layout = KNOWN_LAYOUTS.find(l => l.id === layoutId);
  assert.ok(layout);
  return rowAt(Object.fromEntries(Object.entries(layout.columns).map(([letter, [h]]) => [letter, h ?? `Synthetic ${letter}`])));
}

const LAUNCH_TRACKER_ROWS: TestCell[][] = [
  ['Synthetic launch tracker'],
  [],
  headerRow('launch_tracker'),
  rowAt({
    A: 'Skincare',
    B: 'Team A',
    C: 12,
    D: 'Prestige skincare - Korean',
    E: 'call the brand',
    F: 'A. Person',
    G: 'Vendor One LLC',
    H: '30% + 5% marketing',
    N: 'Y',
    Q: 'tbc',
    R: 'Signed',
    W: 'PURPLE',
    X: 'Brand Alpha',
    Y: 0.05,
    AA: 'YES - 6 MONTHS',
    AD: 'Local',
    AH: 'Q2 - New to market',
    AI: 'GONDOLA 4FT 5 SHELVES',
    AK: 'WALL 6FT',
    AR: 'SAME AS SB',
    AS: 'New supplier',
    AU: 'Pending',
    BM: 'kept anyway',
  }),
  rowAt({ D: 'Fragrance', G: 'BRAND', H: 0.4, N: { error: '#N/A' }, W: 'PURPLE DOUBLE', X: 'Brand Alpha' }),
  rowAt({
    D: 'Mass cosmetics',
    G: 'VENDOR ONE L.L.C',
    X: 'Brand Beta',
    N: 'maybe later',
    AI: 'TEMP ENDCAP',
    Y: 'tbc',
    AZ: '=HYPERLINK("x")',
    AS: 'ask finance',
  }),
  rowAt({ D: 'Prestige skincare - Korean', X: 'Brand Alpha', N: 'No' }),
  rowAt({ E: 'a note on a row with no brand' }),
];

const AVENUES_ROWS: TestCell[][] = [
  headerRow('avenues'),
  rowAt({
    A: 'Cosmetics',
    B: 'Mass cosmetics',
    C: 'Owner A',
    D: 'Vendor Two',
    F: 'Brand Gamma',
    H: 'OK',
    I: 'Ulta US',
    J: 'In US, new to ME',
    K: 'NO',
    L: 'Yes',
    M: '+30 DAYS',
    O: 'Y',
    P: 'N',
    Q: 'N',
    R: 0.35,
    T: 'Existing',
    W: { date: 46_330 },
    X: 'TBC',
    AA: 'Done',
    AB: 'Y',
    AD: 'Pending',
  }),
  rowAt({ B: 'Body', F: 'Brand Delta', L: 'no', W: 'Contractor X', X: '9th December' }),
];

function sheetOf(rows: TestCell[][], name: string): Sheet {
  const sheet = readWorkbook(buildXlsx([{ name, rows }])).sheets[0];
  assert.ok(sheet);
  return sheet;
}

const ctx: ImportContext = {
  launch: 'TEST-LAUNCH',
  storeMap: { S1: 'SA', S2: 'SB', AK: 'RA' },
  stores: [
    { code: 'SA', aliases: ['Store A'] },
    { code: 'SB', aliases: ['Store B'] },
    { code: 'RA', aliases: [] },
  ],
  brands: ['Brand Alpha'],
  vendors: [{ name: 'Vendor Two', aliases: [] }],
  defaultYear: 2026,
};

function prepareLaunchTracker() {
  const sheet = sheetOf(LAUNCH_TRACKER_ROWS, 'LAUNCH TRACKER');
  const detected = detectLayout(sheet);
  assert.ok(detected);
  return prepareImport(sheet, detected.layout, detected.headerRow, ctx);
}

function line(lines: ImportedLine[], rowNo: number): ImportedLine {
  const l = lines.find(x => x.rowNo === rowNo);
  assert.ok(l, `no line from row ${String(rowNo)}`);
  return l;
}

test('both old layouts are detected by their header row', () => {
  assert.deepEqual(
    (({ layout, headerRow }) => [layout.id, headerRow])(
      detectLayout(sheetOf(LAUNCH_TRACKER_ROWS, 'LAUNCH TRACKER')) ?? { layout: { id: 'none' }, headerRow: 0 },
    ),
    ['launch_tracker', 3],
  );
  assert.equal(detectLayout(sheetOf(AVENUES_ROWS, 'AVENUES'))?.layout.id, 'avenues');
  assert.equal(
    detectLayout(
      sheetOf(
        [
          ['Name', 'Phone'],
          ['x', 'y'],
        ],
        'Other',
      ),
    ),
    undefined,
  );
});

test('the wizard asks only for store groups whose columns hold values', () => {
  const sheet = sheetOf(LAUNCH_TRACKER_ROWS, 'LAUNCH TRACKER');
  const detected = detectLayout(sheet);
  assert.ok(detected);
  assert.deepEqual(usedGroups(sheet, detected.layout, detected.headerRow), ['S1', 'S2', 'AK']);
  assert.throws(
    () => prepareImport(sheet, detected.layout, detected.headerRow, { ...ctx, storeMap: { S1: 'SA' } }),
    (err: unknown) => err instanceof MappingError && err.message === 'Pick the store these columns belong to: S2, AK.',
  );
});

test('LAUNCH TRACKER: values are cleaned into the organised fields', () => {
  const { lines } = prepareLaunchTracker();
  assert.equal(lines.length, 4);
  const first = line(lines, 4);
  assert.equal(first.key, 'prestige skincare - korean brand alpha');
  assert.equal(first.lineId, null);
  const f = first.fields;
  assert.equal(f.Launch, 'TEST-LAUNCH');
  assert.equal(f.Zone, 'Prestige skincare');
  assert.equal(f['Sub-zone'], 'Korean');
  assert.equal(f['Store 1'], 'SA');
  assert.equal(f['S1 Listing'], 'Yes');
  assert.equal(f['S2 Listing'], 'TBC');
  assert.equal(f['Brand code'], 'Purple');
  assert.equal(f['Double placement'], 'No');
  assert.equal(f['S1 Fixture type'], 'Gondola');
  assert.equal(f['S1 Width ft'], 4);
  assert.equal(f['S1 Shelves'], 5);
  assert.equal(f['Data set-up'], 'New to market');
  assert.equal(f['Data set-up quarter'], 'Q2');
  assert.equal(f.Schematics, 'Same as');
  assert.equal(f['Schematics same as'], 'SB');
  assert.equal(f['Penetration plan'], 0.05);
  assert.match(String(f.Notes), /Action Plan: call the brand/);
  assert.match(String(f.Notes), /Col BM: kept anyway/);
  assert.deepEqual(first.distribution.QAT, {
    'Contacts as written': 'A. Person',
    'Distributor as written': 'Vendor One LLC',
    'Distribution status': 'Distributor',
    Distributor: 'Vendor One LLC',
    Margin: 0.3,
    'Extra margin': 0.05,
    'Margin terms': 'marketing',
    'Margin as written': '30% + 5% marketing',
    'Exclusive months': 6,
    Exclusive: 'Yes',
    Source: 'LAUNCH TRACKER row 4',
  });
  assert.equal(first.refFixtures.RA?.['Fixture type'], 'Wall');
});

test('LAUNCH TRACKER: placeholders, unknown values, doubles and duplicates are listed for review', () => {
  const { lines, normalisations, exceptions } = prepareLaunchTracker();

  const double = line(lines, 5);
  assert.equal(double.fields['Double placement'], 'Yes');
  assert.equal(double.fields['Brand code'], 'Purple');
  assert.equal(double.doubleOfRow, 4);
  assert.equal(double.distribution.QAT?.Distributor, 'Brand Alpha');
  assert.equal(double.distribution.QAT.Margin, 0.4);
  assert.equal(double.fields['S1 Listing'], null);

  const beta = line(lines, 6);
  assert.equal(beta.fields['S1 Listing'], null);
  assert.match(String(beta.fields.Notes), /S1 Listing: maybe later/);
  assert.equal(beta.fields['S1 Fixture type'], 'Temp endcap');
  assert.equal(beta.fields['Penetration plan'], null);
  assert.equal(beta.fields['Penetration notes'], 'Penetration plan: tbc');
  assert.equal(beta.fields['Vendor set-up note'], 'ask finance');
  assert.equal(beta.distribution.QAT?.Distributor, 'Vendor One LLC', 'spellings that differ only in punctuation are one vendor');
  assert.equal(beta.fields['Feedback schematics'], '=HYPERLINK("x")', 'text is imported as text, never run');

  const dup = line(lines, 7);
  assert.equal(dup.key, 'prestige skincare - korean brand alpha#2');
  assert.equal(dup.fields['External key'], 'Prestige skincare - Korean Brand Alpha#2');

  const kinds = exceptions.map(e => `${String(e.rowNo)} ${e.kind}`);
  assert.deepEqual(kinds.sort(), [
    '4 unknown_vendor',
    '5 cleared_error',
    '5 double_linked',
    '6 unknown_brand',
    '6 unknown_value',
    '7 duplicate',
    '8 unknown_value',
  ]);
  assert.match(exceptions.find(e => e.rowNo === 8)?.message ?? '', /no brand/);
  assert.ok(exceptions.every(e => e.sheet === 'LAUNCH TRACKER'));

  const n = (field: string, original: string) => normalisations.find(x => x.field === field && x.original === original)?.storedAs;
  assert.equal(n('S1 Listing', 'Y'), 'Yes');
  assert.equal(n('S1 Listing', '#N/A'), '(empty)');
  assert.equal(n('S1 Listing', 'maybe later'), '(moved to Notes)');
  assert.equal(n('Brand code', 'PURPLE'), 'Purple');
  assert.equal(n('Brand code', 'PURPLE DOUBLE'), 'Purple · double placement');
  assert.equal(n('Vendor set-up route', 'ask finance'), '(moved to Vendor set-up note)');
  assert.equal(n('Margin (QAT)', '30% + 5% marketing'), 'base 30% · extra 5% · terms "marketing"');
  assert.equal(n('Distributor (QAT)', 'VENDOR ONE L.L.C'), 'Vendor One LLC');
  assert.equal(n('Distributor (QAT)', 'BRAND'), 'Distribution status: Distributor');
});

test('AVENUES: installs, VPA flags and list values', () => {
  const sheet = sheetOf(AVENUES_ROWS, 'AVENUES');
  const detected = detectLayout(sheet);
  assert.ok(detected);
  const { lines, exceptions } = prepareImport(sheet, detected.layout, detected.headerRow, { ...ctx, storeMap: { S1: 'SK' }, stores: [{ code: 'SK' }] });
  assert.equal(lines.length, 2);
  const gamma = line(lines, 2);
  assert.equal(gamma.fields['Store 1'], 'SK');
  assert.equal(gamma.fields['S1 At launch'], 'Yes');
  assert.equal(gamma.fields['S1 At launch recheck'], '+30 days');
  assert.equal(gamma.fields['VPA status'], 'Shared');
  assert.equal(gamma.fields['Marketing OK'], 'OK');
  assert.equal(gamma.fields.From, 'Ulta US');
  assert.equal(gamma.fields['S1 PO'], 'Pending');
  assert.equal(gamma.distribution.KWT?.Exclusive, 'No');
  assert.equal(gamma.distribution.KWT.Margin, 0.35);
  assert.deepEqual(gamma.install, {
    'Install start': '2026-11-04',
    'Install status': 'Scheduled',
    Contractor: null,
    'Delivery date': null,
    'Delivery status': 'TBC',
    'VM status': 'Done',
    'Wall perimeter': 'Yes',
    Store: 'SK',
    Brand: 'Brand Gamma',
    Source: 'AVENUES row 2',
  });
  const delta = line(lines, 3);
  assert.equal(delta.install?.Contractor, 'Contractor X');
  assert.equal(delta.install['Install status'], null);
  assert.equal(delta.install['Delivery date'], '2026-12-09');
  assert.equal(delta.install['Delivery status'], 'Scheduled');
  assert.equal(delta.fields['VPA status'], null);
  assert.deepEqual(exceptions.map(e => e.kind).sort(), ['unknown_brand', 'unknown_brand']);
});

function stored(lines: ImportedLine[]): ExistingLine[] {
  return lines.map((l, i) => ({ lineId: `L-${String(i + 1)}`, externalKey: String(l.fields['External key']), values: flatten(l) }));
}

test('re-importing the same file creates nothing and changes nothing', () => {
  const first = prepareLaunchTracker();
  const again = prepareLaunchTracker();
  const plan = planReimport(stored(first.lines), again.lines);
  assert.deepEqual(plan.summary, { create: 0, update: 0, unchanged: 4, notInFile: 0 });
});

test('re-importing an edited file updates matched lines, lists each change, creates new rows and keeps missing lines', () => {
  const existing = stored(prepareLaunchTracker().lines);
  const edited = LAUNCH_TRACKER_ROWS.map(r => [...r]);
  const alpha = edited[3];
  assert.ok(alpha);
  alpha[13] = 'No'; // N: S1 Listing Yes → No
  edited.splice(5, 1); // drop the Brand Beta row
  edited.push(rowAt({ D: 'Body', X: 'Brand Epsilon' }));
  const sheet = sheetOf(edited, 'LAUNCH TRACKER');
  const detected = detectLayout(sheet);
  assert.ok(detected);
  const plan = planReimport(existing, prepareImport(sheet, detected.layout, detected.headerRow, ctx).lines);
  assert.deepEqual(plan.summary, { create: 1, update: 1, unchanged: 2, notInFile: 1 });
  const update = plan.changes.find(c => c.action === 'update');
  assert.equal(update?.lineId, 'L-1');
  assert.deepEqual(update.fields, [{ path: 'line.S1 Listing', from: 'Yes', to: 'No' }]);
  const created = plan.changes.find(c => c.action === 'create');
  assert.ok(created?.fields.some(f => f.path === 'line.Brand' && f.to === 'Brand Epsilon'));
});

test('a Line ID in the file wins over the external key', () => {
  const existing: ExistingLine[] = [{ lineId: 'L-9', externalKey: 'Body Brand Old', values: {} }];
  const incoming = [
    {
      rowNo: 5,
      key: 'L-9',
      lineId: 'L-9',
      fields: { 'Line ID': 'L-9', 'External key': 'Body Brand New' },
      distribution: {},
      refFixtures: {},
      install: null,
      doubleOfRow: null,
    },
  ];
  const plan = planReimport(existing, incoming);
  assert.equal(plan.changes[0]?.lineId, 'L-9');
  assert.deepEqual(plan.changes[0].fields, [{ path: 'line.External key', from: null, to: 'Body Brand New' }]);
});
