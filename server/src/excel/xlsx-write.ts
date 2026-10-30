import { strToU8, strFromU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { columnIndex, columnLetters } from './xlsx-read.js';

/**
 * Writes .xlsx files: the organised workbook filled from the repo's template, and one-sheet workbooks for
 * vendor packs and install schedules. Cell values are never written as formulas, and text that Excel
 * would read as one when edited (= + - @, or a leading tab or line break) is marked as text.
 */

export type CellOut = string | number | null | undefined;
export type TableRow = Record<string, CellOut>;

/** Text Excel or a CSV reader would take as a formula. */
export function formulaLike(s: string): boolean {
  return /^[=+\-@\t\r\n]/.test(s);
}

/** First data row of every table in the template (headers are on row 4). */
const FIRST_ROW = 5;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

function xmlEscape(s: string): string {
  // Characters XML 1.0 cannot carry are dropped, or Excel refuses the file.
  return (
    s
      // eslint-disable-next-line no-control-regex -- matching control characters is the point
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  );
}

function dateSerial(iso: string): number | undefined {
  const m = ISO_DATE.exec(iso);
  if (!m) return undefined;
  return (Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - EXCEL_EPOCH) / 86_400_000;
}

interface Styles {
  date: number;
  percent: number;
  text: number;
}

type ColumnFormat = 'date' | 'percent' | undefined;

function cellXml(ref: string, v: CellOut, format: ColumnFormat, styles: Styles, baseStyle?: string): string {
  if (v === null || v === undefined || v === '') return '';
  const s = baseStyle ? ` s="${baseStyle}"` : '';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    const style = format === 'percent' ? ` s="${String(styles.percent)}"` : format === 'date' ? ` s="${String(styles.date)}"` : s;
    return `<c r="${ref}"${style}><v>${String(v)}</v></c>`;
  }
  const serial = format === 'date' ? dateSerial(v) : undefined;
  if (serial !== undefined) return `<c r="${ref}" s="${String(styles.date)}"><v>${String(serial)}</v></c>`;
  const style = formulaLike(v) ? ` s="${String(styles.text)}"` : s;
  const space = /^\s|\s$/.test(v) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${style} t="inlineStr"><is><t${space}>${xmlEscape(v)}</t></is></c>`;
}

/** Adds the date, percent and text-only cell styles to styles.xml and returns their ids. */
function addStyles(xml: string): { xml: string; styles: Styles } {
  let out = xml;
  const formats = /<numFmts count="(\d+)">([\s\S]*?)<\/numFmts>/.exec(out);
  const ids = [...(formats?.[2] ?? '').matchAll(/numFmtId="(\d+)"/g)].map(m => Number(m[1]));
  const dateFmt = Math.max(163, ...ids) + 1;
  const percentFmt = dateFmt + 1;
  const added = `<numFmt numFmtId="${String(dateFmt)}" formatCode="dd-mmm-yyyy"/><numFmt numFmtId="${String(percentFmt)}" formatCode="0.0%"/>`;
  out = formats
    ? out.replace(formats[0], `<numFmts count="${String(Number(formats[1]) + 2)}">${formats[2] ?? ''}${added}</numFmts>`)
    : out.replace(/<fonts\b/, `<numFmts count="2">${added}</numFmts><fonts`);
  const xfs = /<cellXfs count="(\d+)">/.exec(out);
  if (!xfs) throw new Error('The workbook template has no cellXfs in styles.xml.');
  const n = Number(xfs[1]);
  const xf = (numFmtId: number, attrs: string) => `<xf numFmtId="${String(numFmtId)}" fontId="0" fillId="0" borderId="0" xfId="0" ${attrs}/>`;
  const extra = xf(dateFmt, 'applyNumberFormat="1"') + xf(percentFmt, 'applyNumberFormat="1"') + xf(0, 'quotePrefix="1"');
  out = out.replace(xfs[0], `<cellXfs count="${String(n + 3)}">`).replace('</cellXfs>', `${extra}</cellXfs>`);
  return { xml: out, styles: { date: n, percent: n + 1, text: n + 2 } };
}

interface TemplateTable {
  name: string;
  path: string;
  xml: string;
  startCol: number;
  endCol: number;
  headers: string[];
}

interface TemplateSheet {
  name: string;
  path: string;
  tables: TemplateTable[];
}

function attrOf(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function resolvePart(target: string, base: string): string {
  if (target.startsWith('/')) return target.slice(1);
  return `${base}/${target}`;
}

function readTemplate(files: Record<string, Uint8Array>): TemplateSheet[] {
  const text = (path: string) => {
    const f = files[path];
    if (!f) throw new Error(`The workbook template has no ${path}.`);
    return strFromU8(f);
  };
  const rels = (xml: string) => new Map([...xml.matchAll(/<Relationship\b[^>]*>/g)].map(m => [attrOf(m[0], 'Id') ?? '', attrOf(m[0], 'Target') ?? '']));
  const workbookRels = rels(text('xl/_rels/workbook.xml.rels'));
  return [...text('xl/workbook.xml').matchAll(/<sheet\b[^>]*>/g)].map(m => {
    const name = unescapeXml(attrOf(m[0], 'name') ?? '');
    const path = resolvePart(workbookRels.get(attrOf(m[0], 'r:id') ?? '') ?? '', 'xl');
    const relsPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
    const tables = files[relsPath]
      ? [...rels(text(relsPath)).values()]
          .filter(t => t.includes('/tables/'))
          .map(t => {
            const tablePath = resolvePart(t, 'xl/worksheets').replace(/[^/]+\/\.\.\//, '');
            const xml = text(tablePath);
            const ref = /^([A-Z]+)\d+:([A-Z]+)\d+$/.exec(attrOf(xml, 'ref') ?? '');
            if (!ref?.[1] || !ref[2]) throw new Error(`Table ${tablePath} in the workbook template has no ref.`);
            return {
              name: attrOf(xml, 'name') ?? '',
              path: tablePath,
              xml,
              startCol: columnIndex(ref[1]),
              endCol: columnIndex(ref[2]),
              headers: [...xml.matchAll(/<tableColumn\b[^>]*>/g)].map(c => unescapeXml(attrOf(c[0], 'name') ?? '')),
            };
          })
      : [];
    return { name, path, tables };
  });
}

/** Cells of the rows after the header row, by row number and column index. */
function bodyCells(sheetXml: string): Map<number, Map<number, string>> {
  const rows = new Map<number, Map<number, string>>();
  for (const row of sheetXml.matchAll(/<row r="(\d+)"[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(row[1]);
    if (r < FIRST_ROW) continue;
    const cells = new Map<number, string>();
    for (const c of (row[2] ?? '').matchAll(/<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) cells.set(columnIndex(c[1] ?? 'A'), c[0]);
    rows.set(r, cells);
  }
  return rows;
}

/** 'B5' or 'B5:B5' → 'B5:B<last>' for a column whose table ends on row `last`. */
function extendRefs(sqref: string, lastRowOf: (col: number) => number | undefined): string {
  return sqref
    .split(' ')
    .map(ref => {
      const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(ref);
      if (!m?.[1] || Number(m[2]) !== FIRST_ROW) return ref;
      const last = lastRowOf(columnIndex(m[1]));
      return last && last > FIRST_ROW ? `${m[1]}${String(FIRST_ROW)}:${m[3] ?? m[1]}${String(last)}` : ref;
    })
    .join(' ');
}

export interface FillInput {
  /** Table name (tblLines, tblDistribution…) → rows keyed by the table's headers. */
  tables: Record<string, TableRow[]>;
  /** The Dashboard's launch and up to four stores. */
  dashboard?: { launch: string; stores: string[] };
}

/** The template with every given table filled in; drop-downs, formats and filters cover the new rows. */
export function fillWorkbook(template: Uint8Array, input: FillInput): Uint8Array {
  const files = unzipSync(template);
  const sheets = readTemplate(files);
  const known = new Map(sheets.flatMap(s => s.tables.map(t => [t.name, t] as const)));
  for (const [name, rows] of Object.entries(input.tables)) {
    const table = known.get(name);
    if (!table) throw new Error(`The workbook template has no table ${name}.`);
    const headers = new Set(table.headers);
    for (const row of rows) {
      const unknown = Object.keys(row).filter(h => !headers.has(h));
      if (unknown.length) throw new Error(`${name} has no column ${unknown.join(', ')}.`);
    }
  }

  const stylesFile = files['xl/styles.xml'];
  if (!stylesFile) throw new Error('The workbook template has no xl/styles.xml.');
  const { xml: stylesXml, styles } = addStyles(strFromU8(stylesFile));
  files['xl/styles.xml'] = strToU8(stylesXml);

  for (const sheet of sheets) {
    const filled = sheet.tables.filter(t => input.tables[t.name]?.length);
    const isDashboard = sheet.name === 'Dashboard' && input.dashboard;
    if (!filled.length && !isDashboard) continue;
    const file = files[sheet.path];
    if (!file) throw new Error(`The workbook template has no ${sheet.path}.`);
    let xml = strFromU8(file);

    if (isDashboard && input.dashboard) {
      const values = new Map<string, string>([['B4', input.dashboard.launch]]);
      input.dashboard.stores.slice(0, 4).forEach((s, i) => values.set(`${columnLetters(1 + i)}5`, s));
      for (const [ref, v] of values) {
        xml = xml.replace(new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`), (_m, attrs: string) => {
          return cellXml(ref, v, undefined, styles, attrOf(attrs, 's'));
        });
      }
    }

    if (filled.length) {
      const dateCols = new Set<number>();
      for (const dv of xml.matchAll(/<dataValidation\b[^>]*>/g)) {
        if (attrOf(dv[0], 'type') !== 'date') continue;
        for (const ref of (attrOf(dv[0], 'sqref') ?? '').split(' ')) dateCols.add(columnIndex(/^[A-Z]+/.exec(ref)?.[0] ?? 'A'));
      }
      const rows = bodyCells(xml);
      const lastRow = new Map<string, number>();
      for (const t of filled) {
        const data = input.tables[t.name] ?? [];
        data.forEach((row, i) => {
          const r = FIRST_ROW + i;
          const cells = rows.get(r) ?? new Map<number, string>();
          rows.set(r, cells);
          t.headers.forEach((h, j) => {
            const col = t.startCol + j;
            const format: ColumnFormat = dateCols.has(col) ? 'date' : /^(Margin|Extra margin)$/.test(h) ? 'percent' : undefined;
            const c = cellXml(`${columnLetters(col)}${String(r)}`, row[h], format, styles);
            if (c) cells.set(col, c);
            else cells.delete(col);
          });
        });
        lastRow.set(t.name, FIRST_ROW + data.length - 1);
      }
      const lastRowOf = (col: number) => {
        const t = sheet.tables.find(x => col >= x.startCol && col <= x.endCol);
        return t ? lastRow.get(t.name) : undefined;
      };

      const body = [...rows.entries()]
        .sort(([a], [b]) => a - b)
        .map(([r, cells]) => {
          const ordered = [...cells.entries()].sort(([a], [b]) => a - b).map(([, c]) => c);
          return `<row r="${String(r)}">${ordered.join('')}</row>`;
        })
        .join('');
      const headerEnd = xml.indexOf('</row>', xml.indexOf(`<row r="${String(FIRST_ROW - 1)}"`)) + '</row>'.length;
      const dataEnd = xml.indexOf('</sheetData>');
      xml = xml.slice(0, headerEnd) + body + xml.slice(dataEnd);

      xml = xml.replace(
        /(<(?:dataValidation|conditionalFormatting)\b[^>]*?\bsqref=")([^"]*)"/g,
        (_m, head: string, sqref: string) => `${head}${extendRefs(sqref, lastRowOf)}"`,
      );
      const maxRow = Math.max(FIRST_ROW - 1, ...rows.keys());
      xml = xml.replace(/<dimension ref="([A-Z]+)1:([A-Z]+)\d+"\/>/, (_m, from: string, to: string) => `<dimension ref="${from}1:${to}${String(maxRow)}"/>`);

      for (const t of filled) {
        const ref = `${columnLetters(t.startCol)}${String(FIRST_ROW - 1)}:${columnLetters(t.endCol)}${String(lastRow.get(t.name) ?? FIRST_ROW)}`;
        files[t.path] = strToU8(t.xml.replace(/(<(?:table|autoFilter)\b[^>]*?\bref=")[^"]*"/g, `$1${ref}"`));
      }
    }
    files[sheet.path] = strToU8(xml);
  }
  return zipSync(files, { level: 6 });
}

/** A one-sheet workbook: a bold header row, then the rows, with dates and margins formatted. */
export function writeSheet(sheetName: string, headers: string[], rows: TableRow[], formats: Record<string, 'date' | 'percent'> = {}): Uint8Array {
  const styles: Styles = { date: 2, percent: 3, text: 4 };
  const lines = [headers, ...rows.map(r => headers.map(h => r[h]))].map((values, i) => {
    const r = i + 1;
    const cells = values.map((v, c) =>
      cellXml(`${columnLetters(c)}${String(r)}`, v, i === 0 ? undefined : formats[headers[c] ?? ''], styles, i === 0 ? '1' : undefined),
    );
    return `<row r="${String(r)}">${cells.join('')}</row>`;
  });
  const lastCol = columnLetters(Math.max(headers.length, 1) - 1);
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files: Zippable = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${ns} xmlns:r="${rel}"><sheets><sheet name="${xmlEscape(sheetName.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>`,
    ),
    'xl/styles.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet ${ns}><numFmts count="2"><numFmt numFmtId="164" formatCode="dd-mmm-yyyy"/><numFmt numFmtId="165" formatCode="0.0%"/></numFmts>` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
        '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/></cellXfs></styleSheet>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet ${ns}><dimension ref="A1:${lastCol}${String(lines.length)}"/>` +
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        `<sheetData>${lines.join('')}</sheetData><autoFilter ref="A1:${lastCol}${String(lines.length)}"/></worksheet>`,
    ),
  };
  return zipSync(files, { level: 6 });
}
