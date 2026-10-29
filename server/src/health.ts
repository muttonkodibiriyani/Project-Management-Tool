export interface Check {
  name: string;
  run: (signal: AbortSignal) => Promise<void>;
  /** Says what failed and what to do next. */
  explain: (error: unknown) => string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'failing';
  commit: string | null;
  imageDigest: string | null;
  checks: CheckResult[];
}

export interface HealthOptions {
  commit: string | null;
  imageDigest: string | null;
  timeoutMs?: number;
  cacheMs?: number;
}

/**
 * Runs every check at most once per cacheMs and shares a run in progress, so probes and repeated
 * requests cannot pile load onto the database or storage.
 */
export function healthReporter(checks: Check[], { commit, imageDigest, timeoutMs = 5000, cacheMs = 2000 }: HealthOptions): () => Promise<HealthReport> {
  let last: { startedAt: number; report: Promise<HealthReport> } | undefined;

  const runAll = async (): Promise<HealthReport> => {
    const results = await Promise.all(checks.map(check => runCheck(check, timeoutMs)));
    return { status: results.every(result => result.ok) ? 'ok' : 'failing', commit, imageDigest, checks: results };
  };

  return () => {
    const now = Date.now();
    if (!last || now - last.startedAt >= cacheMs) last = { startedAt: now, report: runAll() };
    return last.report;
  };
}

async function runCheck(check: Check, timeoutMs: number): Promise<CheckResult> {
  const started = performance.now();
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException(`No answer within ${timeoutMs} ms`, 'TimeoutError');
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    await Promise.race([check.run(controller.signal), timedOut]);
    return { name: check.name, ok: true, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return { name: check.name, ok: false, ms: Math.round(performance.now() - started), error: check.explain(error) };
  } finally {
    clearTimeout(timer);
  }
}
