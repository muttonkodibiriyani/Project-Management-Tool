import { matchKey } from './clean.js';
import { DISTRIBUTION_FIELDS, INSTALL_FIELDS, LINE_FIELDS } from './dictionary.js';
import { formulaLike, writeSheet, type CellOut, type TableRow } from './xlsx-write.js';

/**
 * The downloads of the Exports screen built from organised-workbook rows (tblLines, tblDistribution,
 * tblInstalls): CSV per scope, a vendor pack per vendor and an install schedule per store.
 */

export interface OrganisedRows {
  lines: TableRow[];
  distribution: TableRow[];
  installs: TableRow[];
}

export const CSV_SCOPES = {
  lines: LINE_FIELDS.map(([f]) => f),
  distribution: ['Line ID', 'Brand', 'Market', ...DISTRIBUTION_FIELDS],
  installs: ['Line ID', 'Store', ...INSTALL_FIELDS],
} as const satisfies Record<string, readonly string[]>;

export type CsvScope = keyof typeof CSV_SCOPES;

function csvField(v: CellOut): string {
  if (v === null || v === undefined) return '';
  // A leading apostrophe keeps Excel and other spreadsheet apps from running the text as a formula.
  const s = typeof v === 'number' ? String(v) : formulaLike(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 CSV with a byte-order mark, so Excel opens Arabic and accented names correctly. */
export function toCsv(headers: readonly string[], rows: TableRow[]): string {
  const lines = [headers.map(csvField).join(','), ...rows.map(r => headers.map(h => csvField(r[h])).join(','))];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

const DATE_FORMATS = { 'Install start': 'date', 'Install end': 'date', 'Delivery date': 'date' } as const;

function same(a: CellOut, b: string): boolean {
  return typeof a === 'string' && matchKey(a) === matchKey(b);
}

const VENDOR_PACK_HEADERS = [
  'Brand',
  'Zone',
  'Store',
  'Fixture type',
  'Width ft',
  'Shelves',
  'Temporary',
  'Fixture as written',
  'Install start',
  'Install end',
  'Delivery date',
];

/** One vendor's brands with the fixture and dates at each launch store. */
export function vendorPack(vendor: string, rows: OrganisedRows): Uint8Array {
  const lineIds = new Set<CellOut>(
    [...rows.distribution.filter(d => same(d.Distributor, vendor)), ...rows.installs.filter(i => same(i.Vendor, vendor))].map(r => r['Line ID']),
  );
  const out: TableRow[] = [];
  for (const line of rows.lines.filter(l => lineIds.has(l['Line ID']))) {
    for (const n of [1, 2]) {
      const store = line[`Store ${String(n)}`];
      if (typeof store !== 'string' || !store) continue;
      const install = rows.installs.find(i => i['Line ID'] === line['Line ID'] && i.Store === store);
      out.push({
        Brand: line.Brand,
        Zone: line.Zone,
        Store: store,
        'Fixture type': line[`S${String(n)} Fixture type`],
        'Width ft': line[`S${String(n)} Width ft`],
        Shelves: line[`S${String(n)} Shelves`],
        Temporary: line[`S${String(n)} Temporary`],
        'Fixture as written': line[`S${String(n)} Fixture as written`],
        'Install start': install?.['Install start'],
        'Install end': install?.['Install end'],
        'Delivery date': install?.['Delivery date'],
      });
    }
  }
  out.sort((a, b) => String(a.Brand).localeCompare(String(b.Brand)) || String(a.Store).localeCompare(String(b.Store)));
  return writeSheet(`Vendor pack ${vendor}`, VENDOR_PACK_HEADERS, out, DATE_FORMATS);
}

const SCHEDULE_HEADERS = [
  'Install start',
  'Install end',
  'Install status',
  'Brand',
  'Zone',
  'Vendor',
  'Fixture as written',
  'Contractor',
  'Delivery date',
  'Delivery status',
  'VM status',
  'Wall perimeter',
  'Notes',
];

/** One store's installs and deliveries, earliest first; installs without a date come last. */
export function installSchedule(store: string, rows: OrganisedRows): Uint8Array {
  const zones = new Map(rows.lines.map(l => [l['Line ID'], l.Zone]));
  const out = rows.installs
    .filter(i => same(i.Store, store))
    .map((i): TableRow => ({ ...i, Zone: zones.get(i['Line ID']) }))
    .sort(
      (a, b) => String(a['Install start'] ?? '\uffff').localeCompare(String(b['Install start'] ?? '\uffff')) || String(a.Brand).localeCompare(String(b.Brand)),
    );
  return writeSheet(`Installs ${store}`, SCHEDULE_HEADERS, out, DATE_FORMATS);
}
