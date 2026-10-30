import { Unzip, UnzipInflate, type UnzipFile } from 'fflate';
import { SaxesParser, type SaxesTagPlain } from 'saxes';

/**
 * Reads an uploaded .xlsx as hostile input. Only the parts needed for cell values are inflated, each
 * with its bytes counted as they come out, so a zip bomb stops at the limit instead of filling memory.
 * Any XML with a DOCTYPE is refused before an entity can be declared, and macro-enabled packages are
 * refused outright. Formulas are never evaluated: a formula cell yields the value Excel last cached.
 */

export const LIMITS = {
  fileBytes: 25 * 1024 * 1024,
  entries: 5_000,
  partBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  /** Inflated bytes per compressed byte, checked once a part passes 1 MiB. */
  ratio: 200,
  cells: 2_000_000,
};

export type ImportErrorCode = 'not_xlsx' | 'too_large' | 'password_protected' | 'macros' | 'external_entity' | 'zip_bomb' | 'too_many_cells';

const MESSAGES: Record<ImportErrorCode, string> = {
  not_xlsx: "This file isn't an Excel workbook. Save it as .xlsx in Excel and upload it again.",
  too_large: 'The file is larger than 25 MB. Remove unused sheets or images and upload it again.',
  password_protected: 'The workbook is password-protected. Remove the password in Excel (File → Info → Protect Workbook) and upload it again.',
  macros: 'The workbook contains macros, so it was not opened. Save it in Excel as "Excel Workbook (.xlsx)", not macro-enabled, and upload it again.',
  external_entity:
    'The workbook contains XML that points at outside content, so it was not opened. Open it in Excel, save it again as .xlsx and upload the new file.',
  zip_bomb: 'The workbook expands to far more data than its size suggests, so it was not opened. Save it again from Excel and upload the new file.',
  too_many_cells: 'The workbook has more than 2 million filled cells. Remove sheets you do not need to import and upload it again.',
};

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    detail?: string,
  ) {
    super(MESSAGES[code] + (detail ? ` (${detail})` : ''));
    this.name = 'ImportError';
  }
}

export interface CellError {
  error: string;
}
export interface CellDate {
  /** YYYY-MM-DD */
  date: string;
}
export type CellValue = string | number | boolean | CellError | CellDate;
/** cells[c] is column c + 1 (A = 0); missing entries are empty cells. */
export type Row = (CellValue | undefined)[];

export interface Sheet {
  name: string;
  hidden: boolean;
  /** rows[r] is sheet row r + 1. */
  rows: (Row | undefined)[];
  /** Last row holding a value. */
  lastRow: number;
}

export function isCellError(v: CellValue | undefined): v is CellError {
  return typeof v === 'object' && 'error' in v;
}
export function isCellDate(v: CellValue | undefined): v is CellDate {
  return typeof v === 'object' && 'date' in v;
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
// Excel saves a password-protected workbook as an encrypted OLE compound file, not a zip.
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

const WANTED = /^(\[Content_Types\]\.xml|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/sharedStrings\.xml|xl\/styles\.xml|xl\/worksheets\/[^/]+\.xml)$/;
const MACRO_PART = /(^|\/)vbaProject\.bin$|^xl\/macrosheets\//i;

/** Compressed bytes fed to the inflater at a time: deflate expands at most about 1,032 times, so no inflated chunk passes ~4 MiB. */
const PUSH_BYTES = 4096;

function unzipParts(bytes: Uint8Array): Map<string, Uint8Array> {
  const parts = new Map<string, Uint8Array>();
  let entries = 0;
  let total = 0;
  // fflate catches what a callback throws, so a failure is kept here and raised after each push.
  let failure: ImportError | undefined;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file: UnzipFile) => {
    entries += 1;
    if (entries > LIMITS.entries) failure ??= new ImportError('zip_bomb', `more than ${String(LIMITS.entries)} parts`);
    if (MACRO_PART.test(file.name)) failure ??= new ImportError('macros');
    if (failure || !WANTED.test(file.name)) return;
    const chunks: Uint8Array[] = [];
    let inflated = 0;
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) {
        failure = new ImportError('not_xlsx', err.message);
        return;
      }
      inflated += chunk.length;
      total += chunk.length;
      // Parts streamed with a data descriptor carry no compressed size; the absolute limits still hold.
      const bomb = inflated > LIMITS.partBytes || total > LIMITS.totalBytes || (file.size && inflated > 1024 * 1024 && inflated > file.size * LIMITS.ratio);
      if (bomb) {
        failure = new ImportError('zip_bomb');
        file.terminate();
        return;
      }
      chunks.push(chunk);
      if (final) parts.set(file.name, concat(chunks, inflated));
    };
    file.start();
  };
  try {
    for (let at = 0; at < bytes.length && !failure; at += PUSH_BYTES) unzip.push(bytes.subarray(at, at + PUSH_BYTES), at + PUSH_BYTES >= bytes.length);
  } catch (err) {
    failure ??= new ImportError('not_xlsx', err instanceof Error ? err.message : undefined);
  }
  if (failure) throw failure;
  return parts;
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

interface SaxHandlers {
  open?: (tag: SaxesTagPlain) => void;
  close?: (name: string) => void;
  text?: (text: string) => void;
}

/** Parses XML with no DTD: a DOCTYPE (where entities, external or not, are declared) is refused. */
function parseXml(bytes: Uint8Array, handlers: SaxHandlers): void {
  const parser = new SaxesParser({ xmlns: false });
  parser.on('doctype', () => {
    throw new ImportError('external_entity');
  });
  parser.on('error', err => {
    throw new ImportError('not_xlsx', err.message);
  });
  if (handlers.open) parser.on('opentag', handlers.open);
  if (handlers.close) {
    const close = handlers.close;
    parser.on('closetag', tag => {
      close(tag.name);
    });
  }
  if (handlers.text) {
    parser.on('text', handlers.text);
    parser.on('cdata', handlers.text);
  }
  parser.write(new TextDecoder().decode(bytes)).close();
}

function localName(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

function attr(tag: SaxesTagPlain, name: string): string | undefined {
  for (const [k, v] of Object.entries(tag.attributes)) if (localName(k) === name) return v;
  return undefined;
}

function sharedStrings(bytes: Uint8Array | undefined): string[] {
  const out: string[] = [];
  if (!bytes) return out;
  let current = '';
  let inT = false;
  let phonetic = 0;
  parseXml(bytes, {
    open: tag => {
      const n = localName(tag.name);
      if (n === 'si') current = '';
      else if (n === 'rPh') phonetic += 1;
      else if (n === 't' && !phonetic) inT = true;
    },
    close: name => {
      const n = localName(name);
      if (n === 'si') out.push(current);
      else if (n === 'rPh') phonetic -= 1;
      else if (n === 't') inT = false;
    },
    text: t => {
      if (inT) current += t;
    },
  });
  return out;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function isDateFormatCode(code: string): boolean {
  const bare = code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
  return /[dmy]/i.test(bare) && !/^[#0.,%\s]*$/.test(bare);
}

/** Which cell style indexes (s="n") show a date. */
function dateStyles(bytes: Uint8Array | undefined): Set<number> {
  const out = new Set<number>();
  if (!bytes) return out;
  const custom = new Map<number, string>();
  let inCellXfs = false;
  let xf = 0;
  parseXml(bytes, {
    open: tag => {
      const n = localName(tag.name);
      if (n === 'numFmt') custom.set(Number(attr(tag, 'numFmtId')), attr(tag, 'formatCode') ?? '');
      else if (n === 'cellXfs') inCellXfs = true;
      else if (n === 'xf' && inCellXfs) {
        const id = Number(attr(tag, 'numFmtId') ?? 0);
        const code = custom.get(id);
        if (code === undefined ? BUILTIN_DATE_FORMATS.has(id) : isDateFormatCode(code)) out.add(xf);
        xf += 1;
      }
    },
    close: name => {
      if (localName(name) === 'cellXfs') inCellXfs = false;
    },
  });
  return out;
}

/** Excel's serial day number to YYYY-MM-DD (1900 system, which counts a non-existent 29 Feb 1900). */
export function serialToDate(serial: number, date1904 = false): string {
  const days = Math.floor(serial) + (date1904 ? 1462 : 0);
  const epoch = Date.UTC(1899, 11, 30);
  const adjusted = !date1904 && days < 61 ? days + 1 : days;
  return new Date(epoch + adjusted * 86_400_000).toISOString().slice(0, 10);
}

export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function columnLetters(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

interface SheetContext {
  strings: string[];
  dates: Set<number>;
  date1904: boolean;
  cellBudget: { left: number };
}

function readSheet(name: string, hidden: boolean, bytes: Uint8Array, ctx: SheetContext): Sheet {
  const rows: (Row | undefined)[] = [];
  let lastRow = 0;
  let rowIndex = -1;
  let colIndex = -1;
  let type = 'n';
  let style = 0;
  let text = '';
  let inValue = false;
  let inInline = 0;
  let inT = false;
  let hasValue = false;

  parseXml(bytes, {
    open: tag => {
      const n = localName(tag.name);
      if (n === 'row') {
        const r = attr(tag, 'r');
        rowIndex = r ? Number(r) - 1 : rowIndex + 1;
        colIndex = -1;
      } else if (n === 'c') {
        const ref = attr(tag, 'r');
        const letters = ref ? /^[A-Z]+/i.exec(ref)?.[0] : undefined;
        colIndex = letters ? columnIndex(letters) : colIndex + 1;
        type = attr(tag, 't') ?? 'n';
        style = Number(attr(tag, 's') ?? 0);
        text = '';
        hasValue = false;
      } else if (n === 'v') {
        inValue = true;
        hasValue = true;
      } else if (n === 'is') {
        inInline += 1;
        hasValue = true;
      } else if (n === 't' && inInline) inT = true;
    },
    close: name => {
      const n = localName(name);
      if (n === 'v') inValue = false;
      else if (n === 'is') inInline -= 1;
      else if (n === 't') inT = false;
      else if (n === 'c' && hasValue) {
        const value = cellValue(type, text, style, ctx);
        if (value === undefined) return;
        if (--ctx.cellBudget.left < 0) throw new ImportError('too_many_cells');
        const row = (rows[rowIndex] ??= []);
        row[colIndex] = value;
        lastRow = Math.max(lastRow, rowIndex + 1);
      }
    },
    text: t => {
      if (inValue || inT) text += t;
    },
  });
  return { name, hidden, rows, lastRow };
}

function cellValue(type: string, text: string, style: number, ctx: SheetContext): CellValue | undefined {
  switch (type) {
    case 's': {
      const s = ctx.strings[Number(text)];
      return s === undefined || s === '' ? undefined : s;
    }
    case 'inlineStr':
    case 'str':
      return text === '' ? undefined : text;
    case 'b':
      return text === '1';
    case 'e':
      return { error: text };
    default: {
      if (text.trim() === '') return undefined;
      const n = Number(text);
      if (!Number.isFinite(n)) return text;
      return ctx.dates.has(style) ? { date: serialToDate(n, ctx.date1904) } : n;
    }
  }
}

export interface Workbook {
  sheets: Sheet[];
}

export function readWorkbook(bytes: Uint8Array): Workbook {
  if (bytes.length > LIMITS.fileBytes) throw new ImportError('too_large');
  if (startsWith(bytes, OLE_MAGIC)) throw new ImportError('password_protected');
  if (!startsWith(bytes, ZIP_MAGIC)) throw new ImportError('not_xlsx');

  const parts = unzipParts(bytes);
  const contentTypes = parts.get('[Content_Types].xml');
  const workbookXml = parts.get('xl/workbook.xml');
  const relsXml = parts.get('xl/_rels/workbook.xml.rels');
  if (!contentTypes || !workbookXml || !relsXml) throw new ImportError('not_xlsx', 'no workbook part');

  const contentTypeValues: string[] = [];
  parseXml(contentTypes, {
    open: tag => {
      contentTypeValues.push(attr(tag, 'ContentType') ?? '');
    },
  });
  if (contentTypeValues.some(t => /macroEnabled|vbaProject/i.test(t))) throw new ImportError('macros');

  const targets = new Map<string, string>();
  parseXml(relsXml, {
    open: tag => {
      if (localName(tag.name) !== 'Relationship') return;
      const id = attr(tag, 'Id');
      const target = attr(tag, 'Target');
      if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    },
  });

  const declared: { name: string; hidden: boolean; path: string | undefined }[] = [];
  let date1904 = false;
  parseXml(workbookXml, {
    open: tag => {
      const n = localName(tag.name);
      if (n === 'workbookPr') date1904 = ['1', 'true'].includes(attr(tag, 'date1904') ?? '');
      if (n !== 'sheet') return;
      const id = attr(tag, 'id');
      declared.push({ name: attr(tag, 'name') ?? '', hidden: (attr(tag, 'state') ?? 'visible') !== 'visible', path: id ? targets.get(id) : undefined });
    },
  });

  const ctx: SheetContext = {
    strings: sharedStrings(parts.get('xl/sharedStrings.xml')),
    dates: dateStyles(parts.get('xl/styles.xml')),
    date1904,
    cellBudget: { left: LIMITS.cells },
  };
  const sheets: Sheet[] = [];
  for (const d of declared) {
    const xml = d.path ? parts.get(d.path) : undefined;
    // Chart sheets and dialog sheets have no worksheet part and no cells to import.
    if (xml) sheets.push(readSheet(d.name, d.hidden, xml, ctx));
  }
  if (!sheets.length) throw new ImportError('not_xlsx', 'no worksheets');
  return { sheets };
}

export function cell(sheet: Sheet, row: number, col: number): CellValue | undefined {
  return sheet.rows[row - 1]?.[col];
}
