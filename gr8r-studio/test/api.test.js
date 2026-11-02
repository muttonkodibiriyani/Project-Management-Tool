import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiProblem, request, setUnauthorizedHandler, workspacePath } from '../src/core/api.js';

test('request sends the mutation guards and returns response metadata', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let seen;
  globalThis.fetch = async (path, options) => {
    seen = { path, options };
    return new Response(JSON.stringify({ id: 'synthetic-row' }), {
      status: 200,
      headers: { 'content-type': 'application/json', etag: '"3"', location: '/api/v1/synthetic-row' },
    });
  };

  const response = await request('/api/v1/w/synthetic/tasks/task-1', {
    method: 'PATCH',
    body: { title: 'Synthetic task' },
    etag: 2,
    idempotencyKey: 'synthetic-request-1',
  });

  assert.equal(seen.path, '/api/v1/w/synthetic/tasks/task-1');
  assert.equal(seen.options.credentials, 'same-origin');
  assert.equal(seen.options.headers.get('x-requested-with'), 'launch-tracker');
  assert.equal(seen.options.headers.get('if-match'), '2');
  assert.equal(seen.options.headers.get('idempotency-key'), 'synthetic-request-1');
  assert.deepEqual(JSON.parse(seen.options.body), { title: 'Synthetic task' });
  assert.deepEqual(response, { data: { id: 'synthetic-row' }, etag: '"3"', location: '/api/v1/synthetic-row' });
  assert.equal(workspacePath('synthetic workspace', 'tasks'), '/api/v1/w/synthetic%20workspace/tasks');
});

test('a 401 invokes the installed handler once and still rejects with ApiProblem', async t => {
  const previousFetch = globalThis.fetch;
  const previousLocation = globalThis.location;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
    setUnauthorizedHandler(null);
  });
  globalThis.location = { pathname: '/launch', search: '?view=board', hash: '#today' };
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: 401, code: 'unauthorized', detail: 'Sign in again.', requestId: 'synthetic-request' }), {
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
    });
  const handled = [];
  setUnauthorizedHandler(value => handled.push(value));

  await assert.rejects(
    request('/api/v1/me'),
    error =>
      error instanceof ApiProblem &&
      error.status === 401 &&
      error.code === 'unauthorized' &&
      error.detail === 'Sign in again.' &&
      error.requestId === 'synthetic-request',
  );
  assert.equal(handled.length, 1);
  assert.equal(handled[0].returnTo, '/launch?view=board#today');
  assert.equal(handled[0].problem.status, 401);
});
