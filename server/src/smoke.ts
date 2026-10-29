/**
 * The smoke test every environment runs against a started image: the app answers, PostgreSQL and
 * Blob storage are reachable, the web app and its files load with the security policy, and the app
 * reports the commit and image digest it runs.
 *
 *   node dist/smoke.js <app-url> [--expect-digest sha256:...] [--expect-commit <sha>] [--wait <seconds>]
 *
 * Exits 0 when everything passed, 1 when something failed, 2 when the command line is wrong.
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { HealthReport } from './health.js';

export interface SmokeOptions {
  url: string;
  expectDigest?: string;
  expectCommit?: string;
  waitSeconds: number;
}

const REQUEST_TIMEOUT_MS = 5000;

export async function smoke({ url, expectDigest, expectCommit, waitSeconds }: SmokeOptions, print: (line: string) => void): Promise<boolean> {
  const base = url.endsWith('/') ? url : `${url}/`;
  const deadline = Date.now() + waitSeconds * 1000;
  const failures: string[] = [];
  const pass = (what: string) => {
    print(`PASS ${what}`);
  };
  const fail = (what: string, summary: string) => {
    print(`FAIL ${what}`);
    failures.push(summary);
  };
  const get = (path: string) => fetch(new URL(path, base), { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  let lastError = '';
  const answers = async () => {
    try {
      return (await get('healthz')).ok;
    } catch (error) {
      lastError = reason(error);
      return false;
    }
  };
  while (!(await answers())) {
    if (Date.now() >= deadline) {
      fail(
        `The app at ${base} did not answer within ${waitSeconds} s (${lastError || 'it answered with an error'}). ` +
          'Check that the container is running and its port is published; the container log says why it stopped.',
        `the app at ${base} is unreachable`,
      );
      return finish(failures, print);
    }
    await sleep(1000);
  }
  pass(`the app answers at ${base}`);

  let report: HealthReport | undefined;
  for (;;) {
    try {
      report = (await (await get('api/health')).json()) as HealthReport;
    } catch (error) {
      lastError = reason(error);
    }
    if (report?.status === 'ok' || Date.now() >= deadline) break;
    await sleep(1000);
  }
  if (!report) {
    fail(`The app's health report at ${base}api/health could not be read (${lastError}). The container log says why.`, 'the health report is unreadable');
    return finish(failures, print);
  }
  for (const check of report.checks) {
    if (check.ok) pass(`${check.name} is reachable (${check.ms} ms)`);
    else fail(check.error ?? `${check.name} failed its check.`, `${check.name} is unreachable`);
  }

  if (!report.commit) fail('The app reports no commit: the image was built without GIT_COMMIT. Use an image built by CI.', 'the commit is unknown');
  else if (expectCommit && report.commit !== expectCommit) {
    fail(`The app runs commit ${report.commit}, not ${expectCommit}. Start the image built from ${expectCommit}.`, 'the app runs another commit');
  } else pass(`the app runs commit ${report.commit}`);

  if (!report.imageDigest) {
    fail(
      'The app reports no image digest. Start the container with IMAGE_DIGEST set to its digest, as the check scripts and the Azure deployment do.',
      'the image digest is unknown',
    );
  } else if (expectDigest && report.imageDigest !== expectDigest) {
    fail(`The app reports image ${report.imageDigest}, not ${expectDigest}. Start the image by that digest.`, 'the app runs another image');
  } else pass(`the app runs image ${report.imageDigest}`);

  await checkWebApp(get, base, pass, fail);

  if (failures.length === 0) print(`Smoke test passed. commit=${report.commit ?? ''} image=${report.imageDigest ?? ''}`);
  return finish(failures, print);
}

async function checkWebApp(
  get: (path: string) => Promise<Response>,
  base: string,
  pass: (what: string) => void,
  fail: (what: string, summary: string) => void,
): Promise<void> {
  try {
    const page = await get('');
    const html = await page.text();
    const policy = page.headers.get('content-security-policy') ?? '';
    if (!page.ok || !html.includes('<div id="app"')) {
      fail(
        `The web app at ${base} answered ${page.status} without the app page. Check that the image holds the built gr8r-studio.`,
        'the web app does not load',
      );
      return;
    }
    if (!policy.includes("default-src 'self'")) {
      fail(`The web app at ${base} is served without its Content-Security-Policy. Check for a proxy that strips headers.`, 'the security policy is missing');
      return;
    }
    const files = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map(match => match[1] ?? '');
    for (const file of files) {
      const response = await get(file);
      await response.arrayBuffer();
      if (!response.ok) {
        fail(`${base}${file} answered ${response.status}. The image's web app files are incomplete; rebuild it with CI.`, 'a web app file is missing');
        return;
      }
    }
    pass(`the web app loads with its security policy (page and ${files.length} files)`);
  } catch (error) {
    fail(`The web app at ${base} could not be loaded (${reason(error)}).`, 'the web app does not load');
  }
}

function finish(failures: string[], print: (line: string) => void): boolean {
  if (failures.length) print(`Smoke test failed: ${failures.join('; ')}.`);
  return failures.length === 0;
}

function reason(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if (cause instanceof Error && cause.name === 'TimeoutError') return `no answer within ${REQUEST_TIMEOUT_MS / 1000} s`;
  return cause instanceof Error ? cause.message : String(cause);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const USAGE = 'Usage: node dist/smoke.js <app-url> [--expect-digest sha256:...] [--expect-commit <sha>] [--wait <seconds>]';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let options: SmokeOptions;
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: { 'expect-digest': { type: 'string' }, 'expect-commit': { type: 'string' }, wait: { type: 'string', default: '60' } },
    });
    const waitSeconds = Number(values.wait);
    if (positionals.length !== 1 || !URL.canParse(positionals[0] ?? '') || !(waitSeconds > 0)) throw new Error('expected one app URL and a positive --wait');
    options = { url: positionals[0] ?? '', expectDigest: values['expect-digest'], expectCommit: values['expect-commit'], waitSeconds };
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    process.exit(2);
  }
  process.exitCode = (await smoke(options, line => {
    console.log(line);
  }))
    ? 0
    : 1;
}
