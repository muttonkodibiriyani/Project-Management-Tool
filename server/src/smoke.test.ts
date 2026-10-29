import assert from 'node:assert/strict';
import { createServer, type AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import type { HealthReport } from './health.js';
import { smoke } from './smoke.js';

const GR8R_DIST = fileURLToPath(new URL('../../gr8r-studio/dist/', import.meta.url));
const COMMIT = 'c'.repeat(40);
const DIGEST = `sha256:${'d'.repeat(64)}`;

async function run(report: HealthReport, options: { expectDigest?: string; expectCommit?: string } = {}) {
  const app = buildApp({ publicDir: GR8R_DIST, health: () => Promise.resolve(report) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const lines: string[] = [];
  try {
    const passed = await smoke({ url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, waitSeconds: 1, ...options }, line => lines.push(line));
    return { passed, lines };
  } finally {
    await app.close();
  }
}

const healthy: HealthReport = {
  status: 'ok',
  commit: COMMIT,
  imageDigest: DIGEST,
  checks: [
    { name: 'PostgreSQL', ok: true, ms: 2 },
    { name: 'Blob storage', ok: true, ms: 3 },
  ],
};

test('passes against a healthy app and ends with the commit and image digest', async () => {
  const { passed, lines } = await run(healthy, { expectDigest: DIGEST, expectCommit: COMMIT });
  assert.equal(passed, true, lines.join('\n'));
  assert.ok(lines.includes('PASS Blob storage is reachable (3 ms)'));
  assert.match(lines.join('\n'), /PASS the web app loads with its security policy \(page and \d+ files\)/);
  assert.equal(lines.at(-1), `Smoke test passed. commit=${COMMIT} image=${DIGEST}`);
});

test('names the dependency that is unreachable, in plain words', async () => {
  const error = 'Blob storage refused the connection at azurite:10000. Check that the storage service is running.';
  const { passed, lines } = await run({
    ...healthy,
    status: 'failing',
    checks: [
      { name: 'PostgreSQL', ok: true, ms: 2 },
      { name: 'Blob storage', ok: false, ms: 1, error },
    ],
  });
  assert.equal(passed, false);
  assert.ok(lines.includes(`FAIL ${error}`));
  assert.equal(lines.at(-1), 'Smoke test failed: Blob storage is unreachable.');
});

test('fails when the app runs another image or reports none', async () => {
  const other = `sha256:${'e'.repeat(64)}`;
  const { passed, lines } = await run(healthy, { expectDigest: other });
  assert.equal(passed, false);
  assert.ok(lines.includes(`FAIL The app reports image ${DIGEST}, not ${other}. Start the image by that digest.`));
  const unknown = await run({ ...healthy, imageDigest: null });
  assert.equal(unknown.lines.at(-1), 'Smoke test failed: the image digest is unknown.');
});

test('says plainly when nothing answers at the address', async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));
  const lines: string[] = [];
  assert.equal(await smoke({ url: `http://127.0.0.1:${port}`, waitSeconds: 1 }, line => lines.push(line)), false);
  assert.match(
    lines[0] ?? '',
    new RegExp(`^FAIL The app at http://127\\.0\\.0\\.1:${port}/ did not answer within 1 s \\(.*ECONNREFUSED.*\\)\\. Check that the container is running`),
  );
  assert.equal(lines.at(-1), `Smoke test failed: the app at http://127.0.0.1:${port}/ is unreachable.`);
});
