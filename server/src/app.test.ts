import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildApp, CONTENT_SECURITY_POLICY } from './app.js';
import type { HealthReport } from './health.js';

const GR8R_DIST = fileURLToPath(new URL('../../gr8r-studio/dist/', import.meta.url));
assert.ok(existsSync(join(GR8R_DIST, 'index.html')), `Build gr8r-studio first (cd gr8r-studio && npm ci && npm run build): ${GR8R_DIST} has no index.html.`);
const ASSETS = readdirSync(join(GR8R_DIST, 'assets'));

const report = (status: HealthReport['status']): HealthReport => ({
  status,
  commit: 'c'.repeat(40),
  imageDigest: `sha256:${'d'.repeat(64)}`,
  checks: [{ name: 'PostgreSQL', ok: status === 'ok', ms: 1, ...(status === 'ok' ? {} : { error: 'PostgreSQL refused the connection at postgres:5432.' }) }],
});
const app = (status: HealthReport['status'] = 'ok') => buildApp({ publicDir: GR8R_DIST, health: () => Promise.resolve(report(status)) });

test('/healthz answers without asking the database or storage', async () => {
  const response = await buildApp({ publicDir: GR8R_DIST, health: () => Promise.reject(new Error('not called')) }).inject('/healthz');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});

test('/api/health answers 200 when healthy and 503 with the reason when not', async () => {
  const healthy = await app('ok').inject('/api/health');
  assert.equal(healthy.statusCode, 200);
  assert.deepEqual(healthy.json(), report('ok'));
  const failing = await app('failing').inject('/api/health');
  assert.equal(failing.statusCode, 503);
  assert.equal(failing.json<HealthReport>().checks[0]?.error, 'PostgreSQL refused the connection at postgres:5432.');
});

test('the web app is served with the security headers; only content-named files are cached for good', async () => {
  const page = await app().inject('/');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<div id="app"/);
  assert.equal(page.headers['content-security-policy'], CONTENT_SECURITY_POLICY);
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['cache-control'], 'no-cache');

  const script = ASSETS.find(name => name.endsWith('.js')) ?? '';
  const asset = await app().inject(`/assets/${script}`);
  assert.equal(asset.statusCode, 200);
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');

  const missing = await app().inject('/assets/missing.js');
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.headers['cache-control'], 'no-cache');
});

test('the policy allows exactly the inline handlers in the built gr8r-studio', () => {
  const handlers = new Set<string>();
  for (const name of ASSETS.filter(file => file.endsWith('.js'))) {
    for (const match of readFileSync(join(GR8R_DIST, 'assets', name), 'utf8').matchAll(/(?<![\w-])on[a-z]+="([^"]*)"/g)) handlers.add(match[1] ?? '');
  }
  const needed = [...handlers].map(code => `'sha256-${createHash('sha256').update(code).digest('base64')}'`).sort();
  const allowed = (/script-src-attr 'unsafe-hashes' ([^;]*)/.exec(CONTENT_SECURITY_POLICY)?.[1] ?? '').split(' ').sort();
  assert.deepEqual(allowed, needed, `gr8r-studio's inline handlers changed: ${[...handlers].join(' | ')}. Update script-src-attr in app.ts to match.`);
});
