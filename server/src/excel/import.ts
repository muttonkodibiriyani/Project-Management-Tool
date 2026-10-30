import { alnumKey, cellText, describeFixture, isPlaceholder, matchKey, matchList, parseDate, parseFixture, parseMargin } from './clean.js';
import { LINE_KIND, VOCAB, type FieldKind, type ListName } from './dictionary.js';
import { groupOf, type Layout } from './layouts.js';
import { cell, columnIndex, columnLetters, isCellError, type CellValue, type Sheet } from './xlsx-read.js';

/**
 * Turns one sheet into organised-workbook rows (tblLines, tblDistribution, tblRefFixtures, tblInstalls),
 * with every changed spelling and every exception listed for review. Nothing is written anywhere: the
 * caller shows the result (wizard steps 2 to 4) and commits it.
 */

export type Value = string | number | null;
export type Fields = Record<string, Value>;

export interface ImportedLine {
  rowNo: number;
  /** Line ID when the sheet has one, else the normalised 'Zone Brand' as written (duplicates get #2, #3…). */
  key: string;
  lineId: string | null;
  fields: Fields;
  /** Market code → tblDistribution fields. */
  distribution: Record<string, Fields>;
  /** Store code → tblRefFixtures fixture fields. */
  refFixtures: Record<string, Fields>;
  /** tblInstalls fields for Store 1, when the layout has install columns. */
  install: Fields | null;
  /** Row of the first placement, for a DOUBLE line. */
  doubleOfRow: number | null;
}

export interface Normalisation {
  field: string;
  original: string;
  /** The stored value, or '(empty)' when cleared, or '(moved to X)' when kept as text in X. */
  storedAs: string;
  cells: number;
}

export type ExceptionKind = 'unknown_value' | 'duplicate' | 'double_linked' | 'cleared_error' | 'unknown_brand' | 'unknown_vendor' | 'unknown_store';

export interface ImportException {
  sheet: string;
  rowNo: number;
  field: string | null;
  kind: ExceptionKind;
  value: string | null;
  message: string;
}

export interface ImportContext {
  /** Launch code every line goes into. */
  launch: string;
  /** Store group (S1, S2, a reference column) → store code, as picked in the wizard. */
  storeMap: Record<string, string>;
  /** The workspace's stores, to read 'SAME AS DH' and store columns. */
  stores?: { code: string; aliases?: string[] }[];
  /** The workspace's brands; others are listed as new. */
  brands?: string[];
  /** The workspace's vendors and their aliases; distributor spellings are merged into these. */
  vendors?: { name: string; aliases?: string[] }[];
  /** Year for a date written without one ('9th December'). */
  defaultYear?: number;
  /** Column letter → target, overriding the layout (wizard mapping table). */
  mapping?: Record<string, string>;
}

export interface PreparedImport {
  sheet: string;
  layout: Layout['id'];
  lines: ImportedLine[];
  normalisations: Normalisation[];
  exceptions: ImportException[];
}

export class MappingError extends Error {
  constructor(readonly groups: string[]) {
    super(`Pick the store these columns belong to: ${groups.join(', ')}.`);
    this.name = 'MappingError';
  }
}

const SLOT_FIXTURE = /^(S\d) Fixture as written$/;
const PENETRATION = /^Penetration (plan|UAE)/;
const FROM_US = /^(from |via )?(ulta )?us( dc| brand)?$/;

class Collector {
  private readonly norm = new Map<string, Normalisation>();
  readonly exceptions: ImportException[] = [];
  private readonly reported = new Set<string>();

  constructor(readonly sheet: string) {}

  record(field: string, original: string, storedAs: string): void {
    if (original === storedAs) return;
    const k = `${field}\u0000${original}`;
    const n = this.norm.get(k);
    if (n) n.cells += 1;
    else this.norm.set(k, { field, original, storedAs, cells: 1 });
  }

  except(rowNo: number, field: string | null, kind: ExceptionKind, value: string | null, message: string, onceKey?: string): void {
    if (onceKey !== undefined) {
      if (this.reported.has(onceKey)) return;
      this.reported.add(onceKey);
    }
    this.exceptions.push({ sheet: this.sheet, rowNo, field, kind, value, message });
  }

  normalisations(): Normalisation[] {
    return [...this.norm.values()].sort((a, b) => a.field.localeCompare(b.field) || b.cells - a.cells || a.original.localeCompare(b.original));
  }
}

function rawText(v: CellValue | undefined): string {
  if (isCellError(v)) return v.error;
  return cellText(v) ?? '';
}

/** Sets a field unless another column of the row already gave it a value. */
function put(target: Fields, field: string, value: Value): void {
  if (value !== null || !(field in target)) target[field] = value;
}

function appendNote(target: Fields, field: string, note: string): void {
  const prev = target[field];
  target[field] = typeof prev === 'string' && prev ? `${prev}\n${note}` : note;
}

class RowReader {
  readonly fields: Fields = {};
  readonly distribution: Record<string, Fields> = {};
  readonly refFixtures: Record<string, Fields> = {};
  install: Fields | null = null;
  rawZone = '';
  rawBrand = '';
  distributorIsBrand: string[] = [];

  constructor(
    private readonly rowNo: number,
    private readonly out: Collector,
    private readonly ctx: Resolver,
  ) {}

  /** A cell that only says #N/A or '-' is cleared and listed. */
  private cleared(field: string, v: CellValue | undefined): boolean {
    if (!isPlaceholder(v)) return false;
    const original = rawText(v);
    this.out.record(field, original, '(empty)');
    if (isCellError(v)) this.out.except(this.rowNo, field, 'cleared_error', original, `${original} was cleared.`);
    return true;
  }

  private list(field: string, list: ListName, v: CellValue | undefined, notes: (note: string) => void): Value {
    const text = cellText(v);
    if (text === null || this.cleared(field, v)) return null;
    const m = matchList(VOCAB[list], text);
    if (!m) {
      notes(`${field}: ${text}`);
      this.out.record(field, text, '(moved to Notes)');
      this.out.except(this.rowNo, field, 'unknown_value', text, `"${text}" is not in the ${field} list, so it was kept in Notes.`);
      return null;
    }
    if (m.partial) notes(`${field}: ${text}`);
    this.out.record(field, text, m.value);
    return m.value;
  }

  private lineNote = (note: string): void => {
    appendNote(this.fields, 'Notes', note);
  };

  note(label: string, v: CellValue | undefined): void {
    const text = cellText(v);
    if (text !== null) this.lineNote(`${label}: ${text}`);
  }

  line(field: string, v: CellValue | undefined): void {
    const f = this.fields;
    const text = cellText(v);
    const slot = SLOT_FIXTURE.exec(field)?.[1];
    if (slot) {
      put(f, field, text);
      const fx = text === null ? null : parseFixture(text);
      put(f, `${slot} Fixture type`, fx?.type ?? null);
      put(f, `${slot} Width ft`, fx?.widthFt ?? null);
      put(f, `${slot} Shelves`, fx?.shelves ?? null);
      put(f, `${slot} Temporary`, fx ? (fx.temporary ? 'Yes' : 'No') : null);
      if (fx && text !== null) {
        this.out.record(field, text, describeFixture(fx));
        if (!fx.type) this.out.except(this.rowNo, field, 'unknown_value', text, `No fixture type found in "${text}"; the text is kept as written.`);
      }
      return;
    }
    switch (field) {
      case 'Brand': {
        this.rawBrand = text ?? '';
        put(f, field, text === null ? null : this.ctx.brand(text));
        if (text !== null) this.out.record(field, text, this.ctx.brand(text));
        return;
      }
      case 'Brand code': {
        const double = text !== null && /\bdouble\b/i.test(text);
        const rest = text?.replace(/\bdouble\b/gi, '').trim();
        put(f, 'Double placement', text === null ? null : double ? 'Yes' : 'No');
        put(f, field, rest ? this.list(field, 'BrandCode', rest, this.lineNote) : null);
        if (double) this.out.record(field, text, `${String(f[field] ?? '(empty)')} · double placement`);
        return;
      }
      case 'Zone': {
        this.rawZone = text ?? '';
        const whole = text === null ? undefined : matchList(VOCAB.Zone, text);
        const split = text?.split(/\s+[-–]\s+/);
        if (text !== null && !(whole && !whole.partial) && split && split.length > 1 && split[0] && matchList(VOCAB.Zone, split[0])) {
          put(f, field, this.list(field, 'Zone', split[0], this.lineNote));
          put(f, 'Sub-zone', split.slice(1).join(' - '));
          this.out.record('Sub-zone', text, split.slice(1).join(' - '));
          return;
        }
        put(f, field, this.list(field, 'Zone', v, this.lineNote));
        return;
      }
      case 'Data set-up': {
        const q = text === null ? null : /^Q([1-4])\s*[-:]\s*(.+)$/i.exec(text);
        put(f, 'Data set-up quarter', q ? `Q${q[1] ?? ''}` : null);
        put(f, field, this.list(field, 'Registration', q?.[2] ?? v, this.lineNote));
        return;
      }
      case 'Schematics': {
        const same = text === null ? null : /^same as\s+(.+)$/i.exec(text);
        if (same?.[1]) {
          put(f, field, 'Same as');
          put(f, 'Schematics same as', this.ctx.store(same[1], this.rowNo, 'Schematics same as'));
          this.out.record(field, text ?? '', `Same as · ${String(f['Schematics same as'])}`);
          return;
        }
        put(f, field, this.list(field, 'Schematics', v, this.lineNote));
        return;
      }
      case 'Vendor set-up route': {
        // A route that is not in the list is the team's note on the set-up, not an error.
        const m = text === null || isPlaceholder(v) ? undefined : matchList(VOCAB.VendorRoute, text);
        put(f, field, m?.value ?? null);
        if (text === null) return;
        if (m && !m.partial) this.out.record(field, text, m.value);
        else if (isPlaceholder(v)) this.cleared(field, v);
        else {
          appendNote(f, 'Vendor set-up note', text);
          this.out.record(field, text, m ? `${m.value} · note kept` : '(moved to Vendor set-up note)');
        }
        return;
      }
    }
    const kind = LINE_KIND.get(field);
    if (!kind) throw new Error(`Unknown Lines field in a layout: ${field}`);
    if (PENETRATION.test(field) && typeof v === 'string' && !isPlaceholder(v)) {
      put(f, field, null);
      appendNote(f, 'Penetration notes', `${field}: ${v.trim()}`);
      this.out.record(field, v.trim(), '(moved to Penetration notes)');
      return;
    }
    put(f, field, this.typed(field, kind, v, this.lineNote));
  }

  private typed(field: string, kind: FieldKind, v: CellValue | undefined, notes: (note: string) => void): Value {
    const text = cellText(v);
    if (text === null) {
      if (isCellError(v)) this.cleared(field, v);
      return null;
    }
    switch (kind) {
      case 'text':
      case 'launch':
      case 'brandTeam':
      case 'vendor':
      case 'brand':
        return text;
      case 'store':
      case 'storeOrMarket':
        return this.ctx.store(text, this.rowNo, field);
      case 'int':
      case 'dec': {
        if (this.cleared(field, v)) return null;
        const n = typeof v === 'number' ? v : Number(text.replace(/,/g, ''));
        if (Number.isFinite(n) && (kind === 'dec' || Number.isInteger(n))) return n;
        notes(`${field}: ${text}`);
        this.out.record(field, text, '(moved to Notes)');
        return null;
      }
      case 'date': {
        if (this.cleared(field, v)) return null;
        const d = parseDate(v, this.ctx.defaultYear);
        if (d) {
          this.out.record(field, text, d);
          return d;
        }
        notes(`${field}: ${text}`);
        this.out.record(field, text, '(moved to Notes)');
        return null;
      }
      default:
        return this.list(field, kind, v, notes);
    }
  }

  dist(market: string, field: string, v: CellValue | undefined): void {
    const d = (this.distribution[market] ??= {});
    const label = `${field} (${market})`;
    const notes = (note: string) => {
      appendNote(d, 'Notes', note);
    };
    const text = cellText(v);
    switch (field) {
      case 'Distributor': {
        put(d, 'Distributor as written', text ?? (isCellError(v) ? v.error : null));
        if (text === null || this.cleared(label, v)) {
          put(d, 'Distribution status', null);
          put(d, 'Distributor', null);
          return;
        }
        const k = matchKey(text);
        const status =
          k === 'n/a' || k === 'na'
            ? null
            : k === 'tbc'
              ? 'TBC'
              : k === 'need poc'
                ? 'Need POC'
                : /^no distribut/.test(k)
                  ? 'No distributor'
                  : FROM_US.test(k)
                    ? 'From US'
                    : 'Distributor';
        put(d, 'Distribution status', status);
        if (k === 'brand') this.distributorIsBrand.push(market);
        const vendor = status === 'Distributor' && k !== 'brand' ? this.ctx.vendor(text, this.rowNo) : null;
        put(d, 'Distributor', vendor);
        this.out.record(label, text, vendor ?? (status ? `Distribution status: ${status}` : '(empty)'));
        return;
      }
      case 'Margin': {
        if (text === null || this.cleared(label, v)) {
          for (const m of ['Margin', 'Extra margin', 'Margin terms', 'Margin as written']) put(d, m, null);
          return;
        }
        const m = parseMargin(v);
        put(d, 'Margin', m?.margin ?? null);
        put(d, 'Extra margin', m?.extra ?? null);
        put(d, 'Margin terms', m?.terms ?? null);
        put(d, 'Margin as written', m?.asWritten ?? null);
        if (m?.asWritten) {
          const pct = (n: number | null) => (n === null ? '' : `${Number((n * 100).toPrecision(10))}%`);
          const shown = [m.margin === null ? '' : `base ${pct(m.margin)}`, m.extra === null ? '' : `extra ${pct(m.extra)}`, m.terms ? `terms "${m.terms}"` : '']
            .filter(Boolean)
            .join(' · ');
          this.out.record(label, m.asWritten, shown || '(kept as written)');
          if (m.margin === null)
            this.out.except(this.rowNo, label, 'unknown_value', m.asWritten, `No margin figure in "${m.asWritten}"; the text is kept as written.`);
        }
        return;
      }
      case 'Exclusive': {
        const months = text === null ? null : /(\d+)\s*months?/i.exec(text);
        put(d, 'Exclusive months', months?.[1] ? Number(months[1]) : null);
        const rest =
          months && text
            ? text
                .replace(months[0], '')
                .replace(/[\s\-–,]+$/, '')
                .trim()
            : v;
        put(d, 'Exclusive', this.list(label, 'Exclusivity', rest, notes));
        return;
      }
      case 'Registration route':
        put(d, field, this.list(label, 'RegRoute', v, notes));
        return;
      case 'Contacts as written':
      case 'Distributor as written':
        put(d, field, text);
        return;
      default:
        throw new Error(`Unknown distribution target in a layout: ${field}`);
    }
  }

  ref(store: string, v: CellValue | undefined): void {
    const text = cellText(v);
    if (text === null) return;
    const fx = parseFixture(text);
    this.refFixtures[store] = {
      'Fixture as written': text,
      'Fixture type': fx.type,
      'Width ft': fx.widthFt,
      Shelves: fx.shelves,
      Temporary: fx.temporary ? 'Yes' : 'No',
    };
    this.out.record(`Fixture (${store})`, text, describeFixture(fx));
  }

  installField(field: string, v: CellValue | undefined): void {
    const i = (this.install ??= {});
    const notes = (note: string) => {
      appendNote(i, 'Notes', note);
    };
    const text = cellText(v);
    const k = text === null ? '' : matchKey(text);
    switch (field) {
      case 'VM schedule': {
        const d = text === null || isPlaceholder(v) ? undefined : parseDate(v, this.ctx.defaultYear);
        put(i, 'Install start', d ?? null);
        put(i, 'Install status', d ? 'Scheduled' : k === 'tbc' ? 'TBC' : k === 'done' ? 'Done' : null);
        put(i, 'Contractor', text !== null && !d && !['tbc', 'done'].includes(k) && !isPlaceholder(v) ? text : null);
        if (text !== null && d) this.out.record('VM schedule', text, d);
        return;
      }
      case 'Delivery': {
        const d = text === null || isPlaceholder(v) ? undefined : parseDate(v, this.ctx.defaultYear);
        put(i, 'Delivery date', d ?? null);
        const status = d ? 'Scheduled' : k === 'tbc' ? 'TBC' : k === 'delivered' ? 'Delivered' : null;
        put(i, 'Delivery status', status);
        if (text !== null && !status && !isPlaceholder(v)) notes(`Delivery: ${text}`);
        return;
      }
      case 'VM status':
        put(i, 'VM status', this.list('VM status', 'VMStatus', v, notes));
        return;
      case 'Wall perimeter':
        put(i, 'Wall perimeter', this.list('Wall perimeter', 'YesNo', v, notes));
        return;
      default:
        throw new Error(`Unknown install target in a layout: ${field}`);
    }
  }
}

/** Store, brand and vendor names resolved against the workspace, with new ones listed once each. */
class Resolver {
  private readonly stores = new Map<string, string>();
  private readonly brands = new Map<string, string>();
  private readonly knownBrands = new Set<string>();
  private readonly vendors = new Map<string, string>();
  private readonly knownVendors = new Set<string>();
  readonly defaultYear: number | undefined;

  constructor(
    ctx: ImportContext,
    private readonly out: Collector,
  ) {
    for (const s of ctx.stores ?? []) for (const name of [s.code, ...(s.aliases ?? [])]) this.stores.set(alnumKey(name), s.code);
    for (const m of VOCAB.Market) this.stores.set(alnumKey(m), m);
    for (const b of ctx.brands ?? []) {
      this.brands.set(alnumKey(b), b);
      this.knownBrands.add(alnumKey(b));
    }
    for (const v of ctx.vendors ?? []) {
      for (const name of [v.name, ...(v.aliases ?? [])]) {
        this.vendors.set(alnumKey(name), v.name);
        this.knownVendors.add(alnumKey(name));
      }
    }
    this.defaultYear = ctx.defaultYear;
  }

  /** A store code or alias ('DH' for HILLS), or a market code. Unknown names are kept and listed. */
  store(text: string, rowNo: number, field: string): string {
    const code = this.stores.get(alnumKey(text));
    if (code) return code;
    this.out.except(rowNo, field, 'unknown_store', text, `"${text}" is not a store or market code in this workspace.`, `store:${alnumKey(text)}`);
    return text.trim();
  }

  /** The workspace's spelling of a brand, else the first spelling found in the file. */
  brand(text: string): string {
    const k = alnumKey(text);
    const known = this.brands.get(k);
    if (known) return known;
    const name = text.trim().replace(/\s+/g, ' ');
    this.brands.set(k, name);
    return name;
  }

  isNewBrand(name: string): boolean {
    return !this.knownBrands.has(alnumKey(name));
  }

  /** Vendor spellings that differ only in case, spaces or punctuation are one vendor; named aliases too. */
  vendor(text: string, rowNo: number): string {
    const k = alnumKey(text);
    const known = this.vendors.get(k);
    if (known) return known;
    const name = text.trim().replace(/\s+/g, ' ');
    this.vendors.set(k, name);
    if (!this.knownVendors.has(k)) this.out.except(rowNo, 'Distributor', 'unknown_vendor', name, `New vendor: ${name} will be added.`, `vendor:${k}`);
    return name;
  }
}

function parseTarget(target: string): string[] {
  return target.split(':');
}

/** The store groups whose columns hold a value under the header row: the wizard asks which store each one is. */
export function usedGroups(sheet: Sheet, layout: Layout, headerRow: number): string[] {
  const used = new Set<string>();
  for (const [letter, [, target]] of Object.entries(layout.columns)) {
    const group = groupOf(target);
    if (!group || used.has(group)) continue;
    const c = columnIndex(letter);
    for (let r = headerRow + 1; r <= sheet.lastRow; r++) {
      if (cellText(cell(sheet, r, c)) !== null) {
        used.add(group);
        break;
      }
    }
  }
  return layout.groups.map(g => g.id).filter(id => used.has(id));
}

/** Reads every row under the header row into organised rows. Throws MappingError if a used store group has no store. */
export function prepareImport(sheet: Sheet, layout: Layout, headerRow: number, ctx: ImportContext): PreparedImport {
  const missing = usedGroups(sheet, layout, headerRow).filter(g => !ctx.storeMap[g]);
  if (missing.length) throw new MappingError(missing);

  const columns = new Map<string, string>(Object.entries(layout.columns).map(([letter, [, target]]) => [letter, target]));
  for (const [letter, target] of Object.entries(ctx.mapping ?? {})) columns.set(letter.toUpperCase(), target);
  const headers = sheet.rows[headerRow - 1] ?? [];

  const out = new Collector(sheet.name);
  const resolver = new Resolver(ctx, out);
  const lines: ImportedLine[] = [];

  for (let rowNo = headerRow + 1; rowNo <= sheet.lastRow; rowNo++) {
    const cells = sheet.rows[rowNo - 1];
    if (!cells?.some(c => c !== undefined)) continue;
    const r = new RowReader(rowNo, out, resolver);

    for (const [letter, target] of columns) {
      const v = cell(sheet, rowNo, columnIndex(letter));
      const [kind = '', a = '', b = ''] = parseTarget(target);
      if (kind === 'line') r.line(a, v);
      else if (kind === 'dist') r.dist(a, b, v);
      else if (kind === 'ref') r.ref(ctx.storeMap[a] ?? a, v);
      else if (kind === 'install') r.installField(a, v);
      else if (kind === 'notes') r.note(cellText(headers[columnIndex(letter)]) ?? `Col ${letter}`, v);
      else if (kind !== 'skip') throw new Error(`Unknown import target: ${target}`);
    }
    // Columns no layout knows are kept in Notes, so nothing in the sheet is lost.
    cells.forEach((v, c) => {
      const letter = columnLetters(c);
      if (v !== undefined && !columns.has(letter)) r.note(cellText(headers[c]) ?? `Col ${letter}`, v);
    });

    const f = r.fields;
    const brand = f.Brand;
    if (typeof brand !== 'string' || !brand) {
      out.except(rowNo, 'Brand', 'unknown_value', null, 'This row has no brand, so it was not imported as a line.');
      continue;
    }
    f.Launch = ctx.launch;
    for (const g of layout.groups) if (/^S\d$/.test(g.id)) f[`Store ${g.id.slice(1)}`] = ctx.storeMap[g.id] ?? null;
    if (layout.vpaFromFlags) {
      const status = f['VPA signed'] === 'Yes' ? 'Signed' : f['VPA countersigned'] === 'Yes' ? 'Countersigned' : f['VPA shared'] === 'Yes' ? 'Shared' : null;
      const anyFlag = ['VPA signed', 'VPA countersigned', 'VPA shared'].some(k => f[k] !== null && f[k] !== undefined);
      f['VPA status'] = status ?? (anyFlag ? 'Pending' : null);
    }
    f['External key'] ??= `${r.rawZone} ${r.rawBrand}`.trim();
    f.Source = `${sheet.name} row ${rowNo}`;
    for (const market of r.distributorIsBrand) {
      const d = r.distribution[market];
      if (d) d.Distributor = brand;
    }
    for (const d of Object.values(r.distribution)) d.Source = f.Source;
    for (const x of Object.values(r.refFixtures)) x.Source = f.Source;
    if (r.install) {
      r.install.Store = ctx.storeMap.S1 ?? null;
      r.install.Brand = brand;
      r.install.Source = f.Source;
    }
    const lineId = typeof f['Line ID'] === 'string' && f['Line ID'] ? f['Line ID'] : null;
    lines.push({
      rowNo,
      key: lineId ?? matchKey(String(f['External key'])),
      lineId,
      fields: f,
      distribution: r.distribution,
      refFixtures: r.refFixtures,
      install: r.install,
      doubleOfRow: null,
    });
  }

  linkDuplicatesAndDoubles(lines, out);
  const reportedBrands = new Set<string>();
  for (const l of lines) {
    const brand = String(l.fields.Brand);
    if (resolver.isNewBrand(brand) && !reportedBrands.has(alnumKey(brand))) {
      reportedBrands.add(alnumKey(brand));
      out.except(l.rowNo, 'Brand', 'unknown_brand', brand, `New brand: ${brand} will be added.`);
    }
  }
  return { sheet: sheet.name, layout: layout.id, lines, normalisations: out.normalisations(), exceptions: out.exceptions };
}

function linkDuplicatesAndDoubles(lines: ImportedLine[], out: Collector): void {
  const seen = new Map<string, ImportedLine[]>();
  for (const l of lines) {
    const same = seen.get(l.key) ?? [];
    same.push(l);
    seen.set(l.key, same);
    if (same.length > 1 && same[0]) {
      const first = same[0];
      l.key = `${l.key}#${String(same.length)}`;
      l.fields['External key'] = `${String(l.fields['External key'])}#${String(same.length)}`;
      out.except(l.rowNo, null, 'duplicate', l.lineId ?? l.fields['External key'], `Same line as row ${first.rowNo}; imported as a separate line.`);
    }
  }
  const primaries = new Map<string, ImportedLine>();
  for (const l of lines) {
    const k = alnumKey(String(l.fields.Brand));
    if (l.fields['Double placement'] !== 'Yes' && !primaries.has(k)) primaries.set(k, l);
  }
  for (const l of lines) {
    if (l.fields['Double placement'] !== 'Yes') continue;
    const primary = primaries.get(alnumKey(String(l.fields.Brand)));
    l.doubleOfRow = primary?.rowNo ?? null;
    out.except(
      l.rowNo,
      'Double placement',
      'double_linked',
      String(l.fields.Brand),
      primary
        ? `Second placement of row ${primary.rowNo} (${String(l.fields.Brand)}).`
        : `No first placement of ${String(l.fields.Brand)} found; kept as its own line.`,
    );
  }
}

/** One line's values as flat paths (line.Zone, dist.QAT.Margin, ref.RP.Fixture type, install.Install start). */
export function flatten(l: Pick<ImportedLine, 'fields' | 'distribution' | 'refFixtures' | 'install'>): Record<string, Value> {
  const out: Record<string, Value> = {};
  const add = (prefix: string, fields: Fields) => {
    // Source says where a row came from in this file, so it changes whenever rows move.
    for (const [k, v] of Object.entries(fields)) if (k !== 'Source') out[`${prefix}${k}`] = v;
  };
  add('line.', l.fields);
  for (const [m, d] of Object.entries(l.distribution)) add(`dist.${m}.`, d);
  for (const [s, x] of Object.entries(l.refFixtures)) add(`ref.${s}.`, x);
  if (l.install) add('install.', l.install);
  return out;
}

export interface ExistingLine {
  lineId: string;
  /** The line's external key as stored. */
  externalKey: string;
  values: Record<string, Value>;
}

export interface FieldChange {
  path: string;
  from: Value;
  to: Value;
}

export interface LineChange {
  rowNo: number;
  lineId: string | null;
  action: 'create' | 'update' | 'unchanged';
  fields: FieldChange[];
}

export interface ReimportPlan {
  changes: LineChange[];
  summary: { create: number; update: number; unchanged: number; notInFile: number };
}

/**
 * Re-import rule (spec 7.4): a row matches a line by Line ID, then by external key within the launch.
 * Matched lines update only the values that differ, new rows create lines, and lines missing from the
 * file are kept and counted. Only paths the sheet maps are compared, so a sheet never clears a field it
 * does not have.
 */
export function planReimport(existing: ExistingLine[], incoming: ImportedLine[]): ReimportPlan {
  const byId = new Map(existing.map(e => [e.lineId, e]));
  const byKey = new Map(existing.map(e => [matchKey(e.externalKey), e]));
  const matched = new Set<ExistingLine>();
  const changes: LineChange[] = [];
  const summary = { create: 0, update: 0, unchanged: 0, notInFile: 0 };

  for (const l of incoming) {
    const candidate = (l.lineId ? byId.get(l.lineId) : undefined) ?? byKey.get(l.key);
    const e = candidate && !matched.has(candidate) ? candidate : undefined;
    const values = flatten(l);
    if (!e) {
      summary.create += 1;
      const fields = Object.entries(values)
        .filter(([, v]) => v !== null)
        .map(([path, to]) => ({ path, from: null, to }));
      changes.push({ rowNo: l.rowNo, lineId: l.lineId, action: 'create', fields });
      continue;
    }
    matched.add(e);
    const fields: FieldChange[] = [];
    for (const [path, to] of Object.entries(values)) {
      if (path === 'line.Line ID') continue;
      const from = e.values[path] ?? null;
      if (from !== to) fields.push({ path, from, to });
    }
    const action = fields.length ? 'update' : 'unchanged';
    summary[action] += 1;
    changes.push({ rowNo: l.rowNo, lineId: e.lineId, action, fields });
  }
  summary.notInFile = existing.filter(e => !matched.has(e)).length;
  return { changes, summary };
}
