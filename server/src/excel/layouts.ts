import { alnumKey, cellText } from './clean.js';
import { LINE_FIELDS } from './dictionary.js';
import { cell, columnIndex, columnLetters, type Sheet } from './xlsx-read.js';

/**
 * The sheet layouts the importer maps without help: the old LAUNCH TRACKER and AVENUES sheets (column
 * map: data dictionary, "Old workbook columns and where they went") and the organised workbook's Lines.
 *
 * A target says where a column goes:
 *   line:<tblLines field>          'line:S1 Listing'
 *   dist:<market>:<field>          'dist:QAT:Margin' (tblDistribution row of that market)
 *   ref:<store group>              a reference store's fixture
 *   install:<field>                the line's install row for Store 1 (AVENUES)
 *   notes                          kept in Notes as 'Col X: value' or 'Header: value'
 *   skip                           not imported (a formula column that is recomputed)
 * Store columns belong to a store group (S1, S2, or one per reference store); the wizard asks which
 * launch store each group is.
 */

export type LayoutId = 'launch_tracker' | 'avenues' | 'organised';

export interface StoreGroup {
  id: string;
  /** The column whose header names the store in this file, shown in the wizard ("DFC Y/N"). */
  labelColumn: string;
}

export interface Layout {
  id: LayoutId;
  /** Column letter → [header as written, or null when it is not checked; target]. */
  columns: Record<string, [string | null, string]>;
  groups: StoreGroup[];
  /** Derive VPA status from the VPA shared / countersigned / signed flags. */
  vpaFromFlags?: boolean;
}

const LAUNCH_TRACKER: Layout = {
  id: 'launch_tracker',
  // Store-named, person-named and company-named headers are not written here: those columns map by letter.
  columns: {
    A: [null, 'line:Main category'],
    B: ['Brand Team', 'line:Brand team'],
    C: ['Area', 'line:Area'],
    D: ['Category/Zone', 'line:Zone'],
    E: ['Action Plan', 'notes'],
    F: ['POC QAT', 'dist:QAT:Contacts as written'],
    G: ['QAT DISTRIB', 'dist:QAT:Distributor'],
    H: ['QAT MARGIN', 'dist:QAT:Margin'],
    I: ['KSA Distirbutor', 'dist:KSA:Distributor'],
    J: ['POC KSA', 'dist:KSA:Contacts as written'],
    K: ['Distribution', 'dist:UAE:Distributor as written'],
    L: ['POC UAE', 'dist:UAE:Contacts as written'],
    M: [null, 'line:S1 Comms'],
    N: [null, 'line:S1 Listing'],
    O: [null, 'line:S1 Floor plan'],
    P: [null, 'line:S2 Comms'],
    Q: [null, 'line:S2 Listing'],
    R: ['VPA', 'line:VPA status'],
    S: [null, 'line:S2 Floor plan'],
    T: ['KSA MARGIN', 'dist:KSA:Margin'],
    U: ['UAE MARGIN', 'dist:UAE:Margin'],
    V: ['HOST BRAND', 'line:Host group'],
    W: ['BRAND CODE', 'line:Brand code'],
    X: ['BRAND', 'line:Brand'],
    Y: ['PENETRATION QATAR', 'line:Penetration plan'],
    Z: ['ACTUAL PENETRATION UAE - ALL REGIONS LTD', 'line:Penetration UAE all regions'],
    AA: ['EXCLUSIVE QAT', 'dist:QAT:Exclusive'],
    AB: ['THE 8O BRANDS', 'line:The 80 brands'],
    AC: ['INTERNAL CATEGORY', 'line:Internal category'],
    AD: ['FROM', 'line:From'],
    AE: ['Status', 'line:Market status'],
    AF: ['PENETRATION (ACTUAL) UAE', 'line:Penetration UAE actual'],
    AG: ['PENETRATION (PLAN MOE)', 'line:Penetration plan MOE'],
    AH: ['NEW DATA SET UP NEEDED? If not in UAE/KWT/KSA', 'line:Data set-up'],
    AI: [null, 'line:S1 Fixture as written'],
    AJ: [null, 'line:S2 Fixture as written'],
    AK: [null, 'ref:AK'],
    AL: [null, 'ref:AL'],
    AM: [null, 'ref:AM'],
    AN: [null, 'ref:AN'],
    AO: [null, 'ref:AO'],
    AP: ['REGISTRATION FOR KSA', 'dist:KSA:Registration route'],
    AQ: ['PROJECT COMMUNICATION', 'line:Project comms'],
    AR: ['SCHEMATICS APPROVED?', 'line:Schematics'],
    AS: ['Vendor set-up Status', 'line:Vendor set-up route'],
    AT: ['Vendor set-up Status', 'line:Vendor set-up state'],
    AU: ['ICF Status', 'line:ICF'],
    AV: [null, 'line:S1 PO'],
    AW: [null, 'line:S2 PO'],
    AX: ['Brand Team Feedback (Supplier Creation)', 'line:Feedback supplier creation'],
    AY: ['Brand Team Feedback (ICF)', 'line:Feedback ICF'],
    AZ: ['Brand Team Feedback (Schematics)', 'line:Feedback schematics'],
    BL: [null, 'line:External key'],
  },
  groups: [
    { id: 'S1', labelColumn: 'N' },
    { id: 'S2', labelColumn: 'Q' },
    { id: 'AK', labelColumn: 'AK' },
    { id: 'AL', labelColumn: 'AL' },
    { id: 'AM', labelColumn: 'AM' },
    { id: 'AN', labelColumn: 'AN' },
    { id: 'AO', labelColumn: 'AO' },
  ],
};

const AVENUES: Layout = {
  id: 'avenues',
  columns: {
    A: ['Main Category', 'line:Main category'],
    B: ['Category/Zone', 'line:Zone'],
    C: ['FUP', 'line:Follow-up owner'],
    D: ['Distributor', 'dist:KWT:Distributor as written'],
    E: ['Full Distributor', 'notes'],
    F: ['Brand', 'line:Brand'],
    G: [null, 'skip'],
    H: ['MARKETING', 'line:Marketing OK'],
    I: ['FROM', 'line:From'],
    J: ['Status', 'line:Market status'],
    K: ['Exclusive Kuwait', 'dist:KWT:Exclusive'],
    L: [null, 'line:S1 At launch'],
    M: [null, 'line:S1 At launch recheck'],
    N: [null, 'notes'],
    O: ['VPA SHARED', 'line:VPA shared'],
    P: ['CF VPA', 'line:VPA countersigned'],
    Q: ['VPA SIGNED', 'line:VPA signed'],
    R: ['MARGIN', 'dist:KWT:Margin'],
    S: [null, 'line:ICF'],
    T: ['SUPPLIER OPENING FORM', 'line:Supplier opening form'],
    U: ['ACCOUNT/CREDIT OPENING FORM', 'line:Account opening form'],
    V: ['ORDER SHARED', 'line:Order shared'],
    W: ['VM SCHEDULE', 'install:VM schedule'],
    X: ['DELIVERY SCHEDULED', 'install:Delivery'],
    Y: ['Comments', 'line:Comments'],
    Z: ['Permit', 'notes'],
    AA: ['VM Status', 'install:VM status'],
    AB: ['Wall Perimeter', 'install:Wall perimeter'],
    AC: ['ADDED COMMENTS', 'line:Added comments'],
    AD: ['PO Raised', 'line:S1 PO'],
    AE: ['FUP', 'notes'],
  },
  groups: [{ id: 'S1', labelColumn: 'L' }],
  vpaFromFlags: true,
};

/** The store group a column belongs to: a slot's line fields, a reference fixture, or AVENUES' install columns. */
export function groupOf(target: string): string | undefined {
  const slot = /^line:(S\d) /.exec(target);
  if (slot) return slot[1];
  if (target.startsWith('ref:')) return target.slice(4);
  if (target.startsWith('install:')) return 'S1';
  return undefined;
}

export const KNOWN_LAYOUTS: Layout[] = [LAUNCH_TRACKER, AVENUES];

export interface Detected {
  layout: Layout;
  headerRow: number;
}

const HEADER_SCAN_ROWS = 40;
const MIN_SCORE = 0.8;

/** The organised workbook's Lines sheet: its columns are found by header name, wherever they sit. */
function organisedLayout(sheet: Sheet, row: number): Layout | undefined {
  const byHeader = new Map(LINE_FIELDS.map(([f]) => [alnumKey(f), f]));
  const columns: Layout['columns'] = {};
  const lastCol = sheet.rows[row - 1]?.length ?? 0;
  for (let c = 0; c < lastCol; c++) {
    const header = cellText(cell(sheet, row, c));
    const field = header === null ? undefined : byHeader.get(alnumKey(header));
    if (header !== null && field) columns[columnLetters(c)] = [header, `line:${field}`];
  }
  if (Object.keys(columns).length < LINE_FIELDS.length * MIN_SCORE) return undefined;
  return { id: 'organised', columns, groups: [] };
}

function score(sheet: Sheet, layout: Layout, row: number): number {
  const checked = Object.entries(layout.columns).filter(([, [h]]) => h !== null);
  const hits = checked.filter(([letter, [h]]) => {
    const found = cellText(cell(sheet, row, columnIndex(letter)));
    return found !== null && h !== null && alnumKey(found) === alnumKey(h);
  });
  return hits.length / checked.length;
}

/** Finds the header row of a known layout in the first rows of a sheet. */
export function detectLayout(sheet: Sheet): Detected | undefined {
  const last = Math.min(HEADER_SCAN_ROWS, sheet.lastRow);
  for (let row = 1; row <= last; row++) {
    for (const layout of KNOWN_LAYOUTS) if (score(sheet, layout, row) >= MIN_SCORE) return { layout, headerRow: row };
    const organised = organisedLayout(sheet, row);
    if (organised) return { layout: organised, headerRow: row };
  }
  return undefined;
}
