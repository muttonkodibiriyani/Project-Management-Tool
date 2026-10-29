import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { healthReporter, type Check } from './health.js';

const passing = (name: string): Check => ({ name, run: async () => {}, explain: String });
const failing = (name: string): Check => ({
  name,
  run: () => Promise.reject(new Error('down')),
  explain: error => `${name} is down: ${(error as Error).message}`,
});

test('one failing check makes the report failing and says why', async () => {
  const report = await healthReporter([passing('PostgreSQL'), failing('Blob storage')], { commit: 'c'.repeat(40), imageDigest: null })();
  assert.equal(report.status, 'failing');
  assert.equal(report.commit, 'c'.repeat(40));
  assert.deepEqual(
    report.checks.map(check => [check.name, check.ok, check.error]),
    [
      ['PostgreSQL', true, undefined],
      ['Blob storage', false, 'Blob storage is down: down'],
    ],
  );
});

test('requests within cacheMs share one run, so probes cannot pile load on the database', async () => {
  let runs = 0;
  const counted: Check = {
    name: 'counted',
    run: async () => {
      runs += 1;
      await sleep(20);
    },
    explain: String,
  };
  const report = healthReporter([counted], { commit: null, imageDigest: null, cacheMs: 100 });
  await Promise.all([report(), report(), report()]);
  assert.equal(runs, 1);
  await sleep(120);
  assert.equal((await report()).status, 'ok');
  assert.equal(runs, 2);
});

test('a check that hangs fails at the timeout with a TimeoutError', async () => {
  const hanging: Check = { name: 'hanging', run: () => new Promise(() => {}), explain: error => (error as Error).name };
  const started = Date.now();
  const report = await healthReporter([hanging], { commit: null, imageDigest: null, timeoutMs: 50 })();
  assert.equal(report.checks[0]?.error, 'TimeoutError');
  assert.ok(Date.now() - started < 1000);
});
