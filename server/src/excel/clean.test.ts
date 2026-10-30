import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alnumKey, isPlaceholder, matchKey, matchList, parseDate, parseFixture, parseMargin } from './clean.js';
import { VOCAB } from './dictionary.js';

test('matching ignores case, spacing and dash style', () => {
  assert.equal(matchKey('  Late – Registration '), 'late - registration');
  assert.equal(alnumKey('LATE-REGISTRATION'), alnumKey('Late registration'));
});

test('list values match exactly, on letters, as Y/N, as store-only, or by prefix and suffix', () => {
  assert.deepEqual(matchList(VOCAB.Listing, 'late - registration'), { value: 'Late - registration', partial: false });
  assert.deepEqual(matchList(VOCAB.Listing, 'LATE REGISTRATION'), { value: 'Late - registration', partial: false });
  assert.deepEqual(matchList(VOCAB.Listing, 'Y'), { value: 'Yes', partial: false });
  assert.deepEqual(matchList(VOCAB.Listing, 'STORE A only'), { value: 'Other store only', partial: true });
  assert.deepEqual(matchList(VOCAB.Comms, 'TO SEND - waiting for brand'), { value: 'To send', partial: true });
  assert.deepEqual(matchList(VOCAB.ProjectComms, 'GREY - LATE'), { value: 'Grey', partial: true });
  assert.equal(matchList(VOCAB.Listing, 'maybe next year'), undefined);
});

test('placeholders are error values and lone dashes', () => {
  assert.ok(isPlaceholder({ error: '#N/A' }));
  assert.ok(isPlaceholder('#N/A'));
  assert.ok(isPlaceholder(' - '));
  assert.ok(!isPlaceholder('-5'));
  assert.ok(!isPlaceholder('N/A brand'));
});

test('fixtures: type, width, shelves and temporary from free text', () => {
  assert.deepEqual(parseFixture('GONDOLA 4FT 5 SHELVES TEMP'), { type: 'Gondola', widthFt: 4, shelves: 5, temporary: true });
  assert.deepEqual(parseFixture('Half iconic 3 feet'), { type: 'Half iconic', widthFt: 3, shelves: null, temporary: false });
  assert.deepEqual(parseFixture('WALL + ENDCAP'), { type: 'Combination', widthFt: null, shelves: null, temporary: false });
  assert.deepEqual(parseFixture('TEMP ENDCAP'), { type: 'Temp endcap', widthFt: null, shelves: null, temporary: true });
  assert.equal(parseFixture('ICONIC+').type, 'Iconic+');
  assert.equal(parseFixture('see plan').type, null);
});

test('margins: numbers and percentages become fractions; extra margin and terms are split out', () => {
  assert.deepEqual(parseMargin(45), { margin: 0.45, extra: null, terms: null, asWritten: null });
  assert.deepEqual(parseMargin(0.3), { margin: 0.3, extra: null, terms: null, asWritten: null });
  assert.deepEqual(parseMargin('30% + 5% marketing'), { margin: 0.3, extra: 0.05, terms: 'marketing', asWritten: '30% + 5% marketing' });
  assert.deepEqual(parseMargin('to be agreed'), { margin: null, extra: null, terms: 'to be agreed', asWritten: 'to be agreed' });
  assert.equal(parseMargin(undefined), undefined);
});

test('dates: date cells, serials, day/month/year text and "9th December"', () => {
  assert.equal(parseDate({ date: '2026-11-03' }), '2026-11-03');
  assert.equal(parseDate(45_658), '2025-01-01');
  assert.equal(parseDate('3/11/2026'), '2026-11-03');
  assert.equal(parseDate('03.11.26'), '2026-11-03');
  assert.equal(parseDate('9th December', 2026), '2026-12-09');
  assert.equal(parseDate('9th December'), undefined);
  assert.equal(parseDate('31/02/2026'), undefined);
  assert.equal(parseDate('next week'), undefined);
});
