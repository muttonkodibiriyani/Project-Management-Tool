import { VOCAB } from './dictionary.js';
import { isCellDate, isCellError, serialToDate, type CellValue } from './xlsx-read.js';

/**
 * Clean-up rules of the data dictionary's Normalisation section. Each function is pure: it says what a
 * cell becomes, and the importer records the change for the review step.
 */

/** Matching ignores case, repeated spaces, non-breaking spaces and en or em dashes. */
export function matchKey(s: string): string {
  return s.normalize('NFKC').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Letters and digits only: 'Late registration' and 'LATE-REGISTRATION' meet here. */
export function alnumKey(s: string): string {
  return matchKey(s).replace(/[^\p{L}\p{N}]/gu, '');
}

/** The text a cell shows, or null when it is empty or an error. */
export function cellText(v: CellValue | undefined): string | null {
  if (v === undefined || isCellError(v)) return null;
  if (isCellDate(v)) return v.date;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Error values (#N/A) and a lone dash are placeholders: the cell is cleared and the clearing listed. */
export function isPlaceholder(v: CellValue | undefined): boolean {
  if (isCellError(v)) return true;
  return typeof v === 'string' && /^(#n\/a|#ref!|#value!|#div\/0!|#name\?|#null!|#num!|-+)$/i.test(v.trim());
}

const YES = new Set(['y', 'yes', 'true', 'ok']);
const NO = new Set(['n', 'no', 'false']);

export interface ListMatch {
  value: string;
  /** Only part of the text matched (a prefix or suffix): the full text also goes to Notes. */
  partial: boolean;
}

function wordsAt(text: string, value: string, at: 'start' | 'end'): boolean {
  const t = matchKey(text);
  const v = matchKey(value);
  if (t === v || t.length <= v.length) return false;
  if (at === 'start') return t.startsWith(v) && !/[\p{L}\p{N}]/u.test(t.charAt(v.length));
  return t.endsWith(v) && !/[\p{L}\p{N}]/u.test(t.charAt(t.length - v.length - 1));
}

/**
 * Matches text to a list value: exactly (ignoring case, spaces and dashes), then on letters and digits,
 * then Y/N, then a store-only answer, then the longest list value the text starts or ends with
 * ('<name> TO SEND' is To send, 'GREY - LATE' is Grey).
 */
export function matchList(list: readonly string[], raw: string): ListMatch | undefined {
  const key = matchKey(raw);
  const exact = list.find(v => matchKey(v) === key);
  if (exact) return { value: exact, partial: false };
  const a = alnumKey(raw);
  const byAlnum = list.filter(v => alnumKey(v) === a);
  if (byAlnum.length === 1 && byAlnum[0]) return { value: byAlnum[0], partial: false };
  if (list.includes('Yes') && YES.has(key)) return { value: 'Yes', partial: false };
  if (list.includes('No') && NO.has(key)) return { value: 'No', partial: false };
  if (list.includes('Other store only') && /^[\p{L}\p{N}]+( [\p{L}\p{N}]+)? only$/u.test(key)) return { value: 'Other store only', partial: true };
  const longestFirst = [...list].sort((x, y) => y.length - x.length);
  const affix = longestFirst.find(v => wordsAt(raw, v, 'start')) ?? longestFirst.find(v => wordsAt(raw, v, 'end'));
  return affix ? { value: affix, partial: true } : undefined;
}

export interface Fixture {
  type: string | null;
  widthFt: number | null;
  shelves: number | null;
  temporary: boolean;
}

function findTypes(text: string): string[] {
  const types = [...VOCAB.FixtureType].filter(t => t !== 'Combination').sort((x, y) => y.length - x.length);
  let rest = ` ${matchKey(text)} `;
  const found: { at: number; type: string }[] = [];
  for (const t of types) {
    const escaped = matchKey(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}+])`, 'gu');
    for (const m of rest.matchAll(re)) {
      found.push({ at: m.index, type: t });
      rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
    }
  }
  return [...new Set(found.sort((x, y) => x.at - y.at).map(f => f.type))];
}

/** 'GONDOLA 4FT 5 SHELVES TEMP' → Gondola, 4 ft, 5 shelves, temporary. Several types joined with + are a Combination. */
export function parseFixture(text: string): Fixture {
  const types = findTypes(text.replace(/\bTEMP(ORARY)?\b(?! endcap)/gi, ' '));
  const width = /(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')/i.exec(text);
  const shelves = /(\d+)\s*shel(?:f|ves)/i.exec(text);
  const temporary = /\btemp(orary)?\b/i.test(text);
  let type = types[0] ?? null;
  if (types.length > 1 && text.includes('+')) type = 'Combination';
  if (!type && temporary && /endcap/i.test(text)) type = 'Temp endcap';
  return {
    type,
    widthFt: width?.[1] ? Number(width[1]) : null,
    shelves: shelves?.[1] ? Number(shelves[1]) : null,
    temporary,
  };
}

export function describeFixture(f: Fixture): string {
  const parts = [f.type ?? '(type not found)'];
  if (f.widthFt !== null) parts.push(`${f.widthFt} ft`);
  if (f.shelves !== null) parts.push(`${f.shelves} shelves`);
  if (f.temporary) parts.push('temporary');
  return parts.join(' · ');
}

export interface Margin {
  margin: number | null;
  extra: number | null;
  terms: string | null;
  /** The text as written, when it was not a plain number. */
  asWritten: string | null;
}

function percent(n: number): number {
  return Number((n / 100).toPrecision(12));
}

/** A margin as a fraction: 25 and 0.25 are both 0.25 (margins above 1 are percentages). */
export function fraction(n: number): number {
  return n > 1 ? percent(n) : n;
}

/** 45 → 0.45; '45% + 2% logistics' → base 0.45, extra 0.02, terms 'logistics'. */
export function parseMargin(v: CellValue | undefined): Margin | undefined {
  if (typeof v === 'number') return { margin: fraction(v), extra: null, terms: null, asWritten: null };
  const text = cellText(v);
  if (text === null) return undefined;
  const number = /(\d+(?:\.\d+)?)\s*(%?)/g;
  const values = [...text.matchAll(number)].map(m => (m[2] ? percent(Number(m[1])) : fraction(Number(m[1]))));
  const terms = text.replace(number, ' ').replace(/[+&,]/g, ' ').replace(/\s+/g, ' ').trim();
  return { margin: values[0] ?? null, extra: values[1] ?? null, terms: terms || null, asWritten: text };
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function iso(y: number, m: number, d: number): string | undefined {
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return undefined;
  return t.toISOString().slice(0, 10);
}

/**
 * A date cell, an Excel serial number, day/month/year text or '9th December'. A date written without a
 * year takes `defaultYear` (the dictionary's assumption for the old install sheet).
 */
export function parseDate(v: CellValue | undefined, defaultYear?: number): string | undefined {
  if (isCellDate(v)) return v.date;
  if (typeof v === 'number') return v > 0 && v < 2_958_466 ? serialToDate(v) : undefined;
  const text = cellText(v);
  if (text === null) return undefined;
  const dmy = /^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?$/.exec(text);
  if (dmy) {
    const year = dmy[3] ? (dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3])) : defaultYear;
    return year === undefined ? undefined : iso(year, Number(dmy[2]), Number(dmy[1]));
  }
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (ymd) return iso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));
  const words = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*\.?(?:\s+(\d{4}))?$/i.exec(text);
  const month = words?.[2] ? MONTHS[words[2].toLowerCase()] : undefined;
  if (words && month) {
    const year = words[3] ? Number(words[3]) : defaultYear;
    return year === undefined ? undefined : iso(year, month, Number(words[1]));
  }
  return undefined;
}
