import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../config.js';

const LOCAL = {
  PGHOST: 'postgres',
  PGDATABASE: 'launchtracker',
  PGUSER: 'launchtracker',
  PGPASSWORD: 'synthetic-password',
  PGSSLMODE: 'disable',
  BLOB_CONNECTION_STRING: 'BlobEndpoint=http://azurite:10000/launchtracker;AccountName=launchtracker;AccountKey=c3ludGhldGlj',
  BLOB_CONTAINER: 'files',
};

const AZURE = {
  PGHOST: 'launch.postgres.database.azure.com',
  PGDATABASE: 'launchtracker',
  PGUSER: 'id-launch-tracker',
  AZURE_CLIENT_ID: '33333333-3333-4333-8333-333333333333',
  BLOB_ACCOUNT_URL: 'https://stlaunch.blob.core.windows.net',
  BLOB_CONTAINER: 'files',
  CONTAINER_APP_NAME: 'ca-launch-tracker',
  AUTH_MODE: 'entra',
  ENTRA_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
  PUBLIC_ORIGIN: 'https://launch.example.test',
  SESSION_SIGNING_KEY: Buffer.alloc(32, 7).toString('base64'),
};

const refused = (env: NodeJS.ProcessEnv, ...texts: string[]) => {
  assert.throws(
    () => loadConfig(env),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      for (const text of texts) assert.ok(error.message.includes(text), `mentions ${text}:\n${error.message}`);
      return true;
    },
  );
};

test('a laptop or CI runs the test identity provider without a tenant', () => {
  const { auth } = loadConfig({ ...LOCAL, AUTH_MODE: 'dev' });
  assert.equal(auth.mode, 'dev');
  assert.equal(auth.signingKey.length, 32);
});

test('Azure signs people in through the configured tenant, with no client secret', () => {
  const { auth } = loadConfig(AZURE);
  assert.deepEqual(
    { ...auth, signingKey: auth.signingKey.length },
    {
      mode: 'entra',
      tenantId: AZURE.ENTRA_TENANT_ID,
      clientId: AZURE.ENTRA_CLIENT_ID,
      publicOrigin: 'https://launch.example.test',
      managedIdentityClientId: AZURE.AZURE_CLIENT_ID,
      signingKey: 32,
    },
  );
});

test('production refuses the test identity provider and storage account keys', () => {
  refused({ ...AZURE, AUTH_MODE: 'dev' }, 'AUTH_MODE=dev is the test sign-in', 'Set AUTH_MODE=entra');
  refused({ ...LOCAL, AUTH_MODE: 'dev', NODE_ENV: 'production' }, 'AUTH_MODE=dev is the test sign-in', 'BLOB_CONNECTION_STRING holds a storage account key');
  refused({ ...LOCAL, AUTH_MODE: 'dev', CONTAINER_APP_NAME: 'ca-launch-tracker' }, 'AUTH_MODE=dev is the test sign-in');
});

test('the sign-in mode must be chosen; nothing defaults to the test provider', () => {
  refused(LOCAL, 'AUTH_MODE must be entra (Microsoft Entra sign-in) or dev');
  refused({ ...LOCAL, AUTH_MODE: 'none' }, 'not "none"');
});

test('every missing or malformed Entra setting is named, and the signing key is never echoed', () => {
  refused(
    { ...AZURE, ENTRA_TENANT_ID: '', ENTRA_CLIENT_ID: 'contoso', PUBLIC_ORIGIN: 'https://launch.example.test/app', SESSION_SIGNING_KEY: 'c2hvcnQ=' },
    'ENTRA_TENANT_ID is not set',
    'ENTRA_CLIENT_ID must be a GUID',
    'PUBLIC_ORIGIN must be an https:// origin with no path',
    'SESSION_SIGNING_KEY must be at least 32 random bytes',
  );
  refused({ ...AZURE, PUBLIC_ORIGIN: 'http://launch.example.test' }, 'PUBLIC_ORIGIN must be an https:// origin');
  assert.throws(
    () => loadConfig({ ...AZURE, SESSION_SIGNING_KEY: 'c2hvcnQ=' }),
    (error: unknown) => error instanceof Error && !error.message.includes('c2hvcnQ='),
  );
});
