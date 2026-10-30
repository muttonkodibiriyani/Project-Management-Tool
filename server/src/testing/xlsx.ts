import { strToU8, zipSync, type Zippable } from 'fflate';
import { columnIndex, columnLetters } from '../excel/xlsx-read.js';

/**
 * Builds small synthetic .xlsx files the way Excel saves them (shared strings, date styles, cached
 * formula values), so importer tests never need a real workbook.
 */

export type TestCell = string | number | boolean | null | { error: string } | { date: number } | { formula: string; cached: string | number };
export interface TestSheet {
  name: string;
  /** rows[0] is row 1; cells[0] is column A. */
  rows: TestCell[][];
  hidden?: boolean;
}

/** The organised workbook template in the repo (dist/testing → repo root). */
export const TEMPLATE = new URL('../../../templates/launch-workbook/launch-workbook-template.xlsx', import.meta.url);

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const SHEET_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface BuildOptions {
  /** Extra or replacement parts, by path. */
  parts?: Record<string, string | Uint8Array>;
  /** Workbook content type (macro-enabled packages use another one). */
  workbookType?: string;
}

export function buildXlsx(sheets: TestSheet[], options: BuildOptions = {}): Uint8Array {
  const strings: string[] = [];
  const index = new Map<string, number>();
  const shared = (s: string) => {
    let i = index.get(s);
    if (i === undefined) {
      i = strings.length;
      strings.push(s);
      index.set(s, i);
    }
    return i;
  };
  const sheetXml = (sheet: TestSheet) => {
    const rows = sheet.rows.map((cells, r) => {
      const xml = cells.map((v, c) => {
        const ref = `${columnLetters(c)}${String(r + 1)}`;
        if (v === null) return '';
        if (typeof v === 'string') return `<c r="${ref}" t="s"><v>${String(shared(v))}</v></c>`;
        if (typeof v === 'number') return `<c r="${ref}"><v>${String(v)}</v></c>`;
        if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? '1' : '0'}</v></c>`;
        if ('error' in v) return `<c r="${ref}" t="e"><v>${esc(v.error)}</v></c>`;
        if ('date' in v) return `<c r="${ref}" s="1"><v>${String(v.date)}</v></c>`;
        const cached = typeof v.cached === 'string' ? `t="str"` : '';
        return `<c r="${ref}" ${cached}><f>${esc(v.formula)}</f><v>${esc(String(v.cached))}</v></c>`;
      });
      return `<row r="${String(r + 1)}">${xml.join('')}</row>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}"><sheetData>${rows.join('')}</sheetData></worksheet>`;
  };

  const files: Zippable = {};
  sheets.forEach((s, i) => {
    files[`xl/worksheets/sheet${String(i + 1)}.xml`] = strToU8(sheetXml(s));
  });
  const workbookType = options.workbookType ?? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="${workbookType}"/>` +
      sheets.map((_s, i) => `<Override PartName="/xl/worksheets/sheet${String(i + 1)}.xml" ContentType="${SHEET_TYPE}"/>`).join('') +
      `</Types>`,
  );
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>` +
      sheets
        .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${String(i + 1)}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${String(i + 1)}"/>`)
        .join('') +
      `</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      sheets.map((_s, i) => `<Relationship Id="rId${String(i + 1)}" Type="${REL}/worksheet" Target="worksheets/sheet${String(i + 1)}.xml"/>`).join('') +
      `</Relationships>`,
  );
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  );
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${NS}" count="${String(strings.length)}" uniqueCount="${String(strings.length)}">` +
      strings.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') +
      `</sst>`,
  );
  for (const [path, content] of Object.entries(options.parts ?? {})) files[path] = typeof content === 'string' ? strToU8(content) : content;
  return zipSync(files, { level: 6 });
}

/** A row with values at the given column letters ({ A: 'x', AK: 'y' }). */
export function rowAt(cells: Record<string, TestCell>): TestCell[] {
  const row: TestCell[] = [];
  for (const [letter, v] of Object.entries(cells)) {
    const c = columnIndex(letter);
    while (row.length < c) row.push(null);
    row[c] = v;
  }
  return row.map(v => v ?? null);
}
