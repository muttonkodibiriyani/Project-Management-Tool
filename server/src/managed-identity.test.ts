import assert from 'node:assert/strict';
import { test } from 'node:test';
import { managedIdentity } from './managed-identity.js';

const ENV = { IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token', IDENTITY_HEADER: 'synthetic-header' };
const inAnHour = () => String(Math.floor(Date.now() / 1000) + 3600);

test('asks the Container Apps endpoint for the resource as this identity, and reuses the token', async () => {
  const asked: { url: URL; header: string | null }[] = [];
  const endpoint = ((url: URL, init?: RequestInit) => {
    asked.push({ url, header: new Headers(init?.headers).get('x-identity-header') });
    return Promise.resolve(Response.json({ access_token: 'synthetic-token', expires_on: inAnHour() }));
  }) as typeof fetch;
  const identity = managedIdentity('client-1', ENV, endpoint);

  assert.equal((await identity.getToken('https://storage.azure.com/.default')).token, 'synthetic-token');
  await identity.getToken(['https://storage.azure.com/.default']);
  const [request, ...more] = asked;
  assert.ok(request);
  assert.equal(more.length, 0);
  assert.equal(request.header, 'synthetic-header');
  assert.equal(request.url.searchParams.get('resource'), 'https://storage.azure.com');
  assert.equal(request.url.searchParams.get('client_id'), 'client-1');
  assert.equal(request.url.searchParams.get('api-version'), '2019-08-01');
});

test('a token close to expiry is replaced', async () => {
  let calls = 0;
  const endpoint = (() => {
    calls += 1;
    return Promise.resolve(Response.json({ access_token: `token-${calls}`, expires_on: String(Math.floor(Date.now() / 1000) + 60) }));
  }) as typeof fetch;
  const identity = managedIdentity('client-1', ENV, endpoint);
  await identity.getToken('https://storage.azure.com/.default');
  assert.equal((await identity.getToken('https://storage.azure.com/.default')).token, 'token-2');
});

test('outside Azure the error says what to set instead', async () => {
  await assert.rejects(
    managedIdentity('client-1', {}).getToken('https://storage.azure.com/.default'),
    /IDENTITY_ENDPOINT and IDENTITY_HEADER are not set.*set PGPASSWORD and BLOB_CONNECTION_STRING/,
  );
});

test('a refused token names the identity to check', async () => {
  const endpoint = (() => Promise.resolve(Response.json({ error: 'invalid_request' }, { status: 400 }))) as typeof fetch;
  await assert.rejects(
    managedIdentity('client-1', ENV, endpoint).getToken('https://storage.azure.com/.default'),
    /\(HTTP 400\).*client ID client-1 is assigned/,
  );
});
