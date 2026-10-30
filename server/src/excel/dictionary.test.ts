import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { DISTRIBUTION_FIELDS, INSTALL_FIELDS, LINE_FIELDS, VOCAB } from './dictionary.js';
import { CSV_SCOPES } from './exports.js';
import { TEMPLATE } from '../testing/xlsx.js';
import { readWorkbook } from './xlsx-read.js';

function tableHeaders(): Map<string, string[]> {
  const files = unzipSync(readFileSync(TEMPLATE));
  const out = new Map<string, string[]>();
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.startsWith('xl/tables/')) continue;
    const xml = strFromU8(bytes);
    const name = /<table [^>]*\bname="([^"]+)"/.exec(xml)?.[1] ?? '';
    out.set(
      name,
      [...xml.matchAll(/<tableColumn [^>]*\bname="([^"]*)"/g)].map(m => (m[1] ?? '').replace(/&amp;/g, '&')),
    );
  }
  return out;
}

test('every value list matches the Lists sheet of the workbook template', () => {
  const lists = readWorkbook(readFileSync(TEMPLATE)).sheets.find(s => s.name === 'Lists');
  assert.ok(lists);
  const header = lists.rows[3] ?? [];
  for (const [name, values] of Object.entries(VOCAB)) {
    const col = header.indexOf(name);
    assert.ok(col >= 0, `Lists sheet has no ${name} column`);
    const inSheet: unknown[] = [];
    for (let r = 4; lists.rows[r]?.[col] !== undefined; r++) inSheet.push(lists.rows[r]?.[col]);
    assert.deepEqual(inSheet, values, name);
  }
});

test('table columns match the workbook template', () => {
  const headers = tableHeaders();
  assert.deepEqual(
    LINE_FIELDS.map(([f]) => f),
    headers.get('tblLines'),
  );
  assert.deepEqual([...CSV_SCOPES.distribution], headers.get('tblDistribution'));
  assert.deepEqual([...CSV_SCOPES.installs], headers.get('tblInstalls'));
  assert.equal(DISTRIBUTION_FIELDS.length + 3, headers.get('tblDistribution')?.length);
  assert.equal(INSTALL_FIELDS.length + 2, headers.get('tblInstalls')?.length);
});
