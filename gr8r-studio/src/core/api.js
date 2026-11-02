/* ---------- same-origin API transport ---------- */

let unauthorizedHandler = null;

export class ApiProblem extends Error {
  constructor(problem, status) {
    const detail = typeof problem?.detail === 'string' && problem.detail ? problem.detail : `The request failed with HTTP ${status}.`;
    super(detail);
    this.name = 'ApiProblem';
    this.status = Number.isInteger(problem?.status) ? problem.status : status;
    this.code = typeof problem?.code === 'string' ? problem.code : 'http_error';
    this.detail = detail;
    this.errors = Array.isArray(problem?.errors) ? problem.errors : undefined;
    this.current = problem?.current;
    this.requestId = typeof problem?.requestId === 'string' ? problem.requestId : undefined;
  }
}

export function setUnauthorizedHandler(handler) {
  if (handler !== null && typeof handler !== 'function') throw new TypeError('The unauthorized handler must be a function or null.');
  unauthorizedHandler = handler;
}

export function workspacePath(workspace, path = '') {
  if (typeof workspace !== 'string' || !workspace.trim()) throw new TypeError('A workspace slug is required.');
  if (typeof path !== 'string') throw new TypeError('The workspace path must be a string.');
  const suffix = path && !path.startsWith('/') ? `/${path}` : path;
  return `/api/v1/w/${encodeURIComponent(workspace.trim())}${suffix}`;
}

function returnTo() {
  if (typeof location === 'undefined') return '/';
  return `${location.pathname || '/'}${location.search || ''}${location.hash || ''}`;
}

async function bodyOf(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (type === 'application/json' || type === 'application/problem+json' || type?.endsWith('+json')) {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}

export async function request(path, options = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('API requests must use a same-origin absolute path.');
  }
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers({ accept: 'application/json, application/problem+json' });
  if (method !== 'GET' && method !== 'HEAD') headers.set('x-requested-with', 'launch-tracker');
  if (options.etag !== undefined) headers.set('if-match', String(options.etag));
  if (options.idempotencyKey !== undefined) headers.set('idempotency-key', String(options.idempotencyKey));

  let body;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }

  const response = await fetch(path, { method, headers, body, credentials: 'same-origin', signal: options.signal });
  const data = await bodyOf(response);
  if (!response.ok) {
    const problem = new ApiProblem(
      data && typeof data === 'object' ? data : { detail: typeof data === 'string' ? data : response.statusText },
      response.status,
    );
    if (response.status === 401 && unauthorizedHandler) {
      try {
        await unauthorizedHandler({ problem, returnTo: returnTo() });
      } catch {
        // Navigation handlers are best-effort; callers must still receive the API problem.
      }
    }
    throw problem;
  }
  return { data, etag: response.headers.get('etag'), location: response.headers.get('location') };
}
