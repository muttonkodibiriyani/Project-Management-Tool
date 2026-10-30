import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { AUTH_RATE_LIMIT } from './auth/plugin.js';
import { devAuth } from './testing/sessions.js';
import { buildApp, CONTENT_SECURITY_POLICY } from './app.js';
import { publicHealth, type HealthReport } from './health.js';

const GR8R_DIST = fileURLToPath(new URL('../../gr8r-studio/dist/', import.meta.url));
/** These tests never reach the database; a pool only connects on its first query. */
const pool = new pg.Pool();
assert.ok(existsSync(join(GR8R_DIST, 'index.html')), `Build gr8r-studio first (cd gr8r-studio && npm ci && npm run build): ${GR8R_DIST} has no index.html.`);
const ASSETS = readdirSync(join(GR8R_DIST, 'assets'));

const report = (status: HealthReport['status']): HealthReport => ({
  status,
  commit: 'c'.repeat(40),
  imageDigest: `sha256:${'d'.repeat(64)}`,
  checks: [{ name: 'PostgreSQL', ok: status === 'ok', ms: 1, ...(status === 'ok' ? {} : { error: 'PostgreSQL refused the connection at postgres:5432.' }) }],
});
const app = (status: HealthReport['status'] = 'ok') => buildApp({ publicDir: GR8R_DIST, pool, health: () => Promise.resolve(report(status)), auth: devAuth() });

test('/healthz answers without asking the database or storage', async () => {
  const response = await buildApp({ publicDir: GR8R_DIST, pool, health: () => Promise.reject(new Error('not called')), auth: devAuth() }).inject('/healthz');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
});

test('/api/health answers 200 when healthy and 503 when not, naming each check but never why it failed', async () => {
  const healthy = await app('ok').inject('/api/health');
  assert.equal(healthy.statusCode, 200);
  assert.deepEqual(healthy.json(), publicHealth(report('ok')));
  const failing = await app('failing').inject('/api/health');
  assert.equal(failing.statusCode, 503);
  assert.deepEqual(failing.json(), {
    status: 'failing',
    commit: 'c'.repeat(40),
    imageDigest: `sha256:${'d'.repeat(64)}`,
    checks: [{ name: 'PostgreSQL', ok: false }],
  });
  assert.doesNotMatch(failing.body, /postgres:5432|refused/);
});

test('/api/health writes why a check failed to the server log', async () => {
  const lines: string[] = [];
  const logged = buildApp({
    publicDir: GR8R_DIST,
    pool,
    health: () => Promise.resolve(report('failing')),
    auth: devAuth(),
    logger: { level: 'error', stream: { write: (line: string) => lines.push(line) } },
  });
  await logged.inject('/api/health');
  const entry = lines.map(line => JSON.parse(line) as { check?: string; msg?: string }).find(line => line.check === 'PostgreSQL');
  assert.equal(entry?.msg, 'PostgreSQL refused the connection at postgres:5432.');
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

test('sign-in is limited per caller: behind the ingress a spoofed X-Forwarded-For entry does not change the key', async () => {
  const azure = buildApp({ publicDir: GR8R_DIST, pool, health: () => Promise.resolve(report('ok')), auth: devAuth(), proxyHops: 1 });
  // The ingress appends the address it saw; anything to the left of it came from the caller.
  const signIn = (spoofed: string, caller: string) =>
    azure.inject({ url: '/auth/dev-login?email=viewer@example.test', remoteAddress: '100.100.0.1', headers: { 'x-forwarded-for': `${spoofed}, ${caller}` } });
  for (let attempt = 1; attempt <= AUTH_RATE_LIMIT; attempt++) assert.equal((await signIn(`198.51.100.${String(attempt)}`, '203.0.113.7')).statusCode, 302);
  const limited = await signIn('198.51.100.99', '203.0.113.7');
  assert.equal(limited.statusCode, 429);
  assert.match(limited.json<{ error: string }>().error, /^Too many sign-in requests from this address: over 10 a minute\. Wait .+ and try again\.$/);
  assert.equal((await signIn('198.51.100.99', '203.0.113.8')).statusCode, 302, 'another caller behind the same ingress is not locked out');
});

test('off Azure X-Forwarded-For is ignored, so the sign-in limit keys on the connection', async () => {
  const laptop = app();
  const signIn = (forwarded: string) =>
    laptop.inject({ url: '/auth/dev-login?email=viewer@example.test', remoteAddress: '192.0.2.10', headers: { 'x-forwarded-for': forwarded } });
  for (let attempt = 1; attempt <= AUTH_RATE_LIMIT; attempt++) assert.equal((await signIn(`203.0.113.${String(attempt)}`)).statusCode, 302);
  assert.equal((await signIn('203.0.113.99')).statusCode, 429);
});
