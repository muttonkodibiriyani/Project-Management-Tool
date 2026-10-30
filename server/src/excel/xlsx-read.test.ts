import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { buildXlsx } from '../testing/xlsx.js';
import { LIMITS, ImportError, cell, readWorkbook, serialToDate, type ImportErrorCode } from './xlsx-read.js';

function refused(bytes: Uint8Array, code: ImportErrorCode): void {
  assert.throws(
    () => readWorkbook(bytes),
    (err: unknown) => {
      assert.ok(err instanceof ImportError, `expected ImportError, got ${String(err)}`);
      assert.equal(err.code, code);
      assert.match(err.message, /upload|opened/);
      return true;
    },
  );
}

const plain = [{ name: 'Sheet1', rows: [['Brand'], ['Brand Alpha']] }];

test('reads shared strings, numbers, booleans, errors, dates and cached formula values', () => {
  const wb = readWorkbook(
    buildXlsx([
      { name: 'Data', rows: [['text', 12.5, true, { error: '#N/A' }, { date: 46000 }, { formula: 'A1&"x"', cached: 'textx' }, { formula: '1+1', cached: 2 }]] },
      { name: 'Old', rows: [['hidden']], hidden: true },
    ]),
  );
  const [data, old] = wb.sheets;
  assert.ok(data && old);
  assert.deepEqual(data.rows[0], ['text', 12.5, true, { error: '#N/A' }, { date: serialToDate(46000) }, 'textx', 2]);
  assert.equal(data.lastRow, 1);
  assert.equal(old.hidden, true);
  assert.equal(cell(data, 1, 1), 12.5);
});

test('Excel serial dates, including the 1904 system', () => {
  assert.equal(serialToDate(45_658), '2025-01-01');
  assert.equal(serialToDate(44_196, true), '2025-01-01');
});

test('a file over 25 MB is refused before it is opened', () => {
  const big = new Uint8Array(LIMITS.fileBytes + 1);
  big.set([0x50, 0x4b, 0x03, 0x04]);
  refused(big, 'too_large');
});

test('a file that is not a zip, or a zip that is not a workbook, is refused', () => {
  refused(strToU8('Brand,Zone\nBrand Alpha,Body\n'), 'not_xlsx');
  refused(zipSync({ 'readme.txt': strToU8('hello') }), 'not_xlsx');
});

test('a password-protected workbook (encrypted OLE file) is refused with its own message', () => {
  const ole = new Uint8Array(512);
  ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  refused(ole, 'password_protected');
});

test('a zip bomb stops at the ratio limit without inflating the whole part', () => {
  const zeros = new Uint8Array(8 * 1024 * 1024);
  refused(buildXlsx(plain, { parts: { 'xl/worksheets/sheet1.xml': zeros } }), 'zip_bomb');
});

test('XML with a DOCTYPE (where external entities are declared) is refused', () => {
  const xxe =
    '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&e;</t></is></c></row></sheetData></worksheet>';
  refused(buildXlsx(plain, { parts: { 'xl/worksheets/sheet1.xml': xxe } }), 'external_entity');
  const billionLaughs = '<?xml version="1.0"?><!DOCTYPE sst [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><sst><si><t>&b;</t></si></sst>';
  refused(buildXlsx(plain, { parts: { 'xl/sharedStrings.xml': billionLaughs } }), 'external_entity');
});

test('macro-enabled workbooks are refused, by part and by content type', () => {
  refused(buildXlsx(plain, { parts: { 'xl/vbaProject.bin': new Uint8Array(16) } }), 'macros');
  refused(buildXlsx(plain, { workbookType: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml' }), 'macros');
});

test('broken XML is refused as not a workbook', () => {
  refused(buildXlsx(plain, { parts: { 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row>' } }), 'not_xlsx');
});
