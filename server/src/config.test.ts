import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig, loadDatabaseConfig } from './config.js';

const ENTRA = {
  AUTH_MODE: 'entra',
  ENTRA_TENANT_ID: '11111111-1111-4111-8111-111111111111',
  ENTRA_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
  PUBLIC_ORIGIN: 'https://launch.example.test',
  SESSION_SIGNING_KEY: Buffer.alloc(32, 7).toString('base64'),
  CONTAINER_APP_NAME: 'ca-launch-tracker',
};

const LOCAL = {
  PGHOST: 'postgres',
  PGDATABASE: 'launchtracker',
  PGUSER: 'launchtracker',
  PGPASSWORD: 'synthetic-password',
  PGSSLMODE: 'disable',
  BLOB_CONNECTION_STRING: 'BlobEndpoint=http://azurite:10000/launchtracker;AccountName=launchtracker;AccountKey=c3ludGhldGlj',
  BLOB_CONTAINER: 'files',
  AUTH_MODE: 'dev',
};

test('a laptop signs in to its own database and storage with a password and a connection string', () => {
  const config = loadConfig(LOCAL);
  assert.deepEqual(config.database, {
    host: 'postgres',
    port: 5432,
    database: 'launchtracker',
    user: 'launchtracker',
    tls: false,
    password: 'synthetic-password',
  });
  assert.deepEqual(config.storage, { container: 'files', connectionString: LOCAL.BLOB_CONNECTION_STRING });
  assert.equal(config.port, 8080);
  assert.equal(config.commit, null);
  assert.equal(config.imageDigest, null);
});

test('Azure signs in with the managed identity and verifies TLS', () => {
  const clientId = '00000000-0000-0000-0000-000000000001';
  const config = loadConfig({
    PGHOST: 'launch.postgres.database.azure.com',
    PGDATABASE: 'launchtracker',
    PGUSER: 'id-launch-tracker',
    AZURE_CLIENT_ID: clientId,
    BLOB_ACCOUNT_URL: 'https://stlaunch.blob.core.windows.net',
    BLOB_CONTAINER: 'files',
    GIT_COMMIT: 'a'.repeat(40),
    IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
    ...ENTRA,
  });
  assert.deepEqual(config.database, {
    host: 'launch.postgres.database.azure.com',
    port: 5432,
    database: 'launchtracker',
    user: 'id-launch-tracker',
    tls: true,
    clientId,
  });
  assert.deepEqual(config.storage, { container: 'files', accountUrl: 'https://stlaunch.blob.core.windows.net', clientId });
  assert.equal(config.commit, 'a'.repeat(40));
});

test('every missing setting is named in one message', () => {
  assert.throws(
    () => loadConfig({}),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      for (const name of ['PGHOST', 'PGDATABASE', 'PGUSER', 'AZURE_CLIENT_ID', 'BLOB_CONTAINER', 'BLOB_CONNECTION_STRING or BLOB_ACCOUNT_URL']) {
        assert.ok(error.message.includes(name), `${name} is named`);
      }
      return true;
    },
  );
});

test('a malformed value is refused and shown', () => {
  assert.throws(
    () => loadConfig({ ...LOCAL, PGPORT: 'five', PGSSLMODE: 'require', GIT_COMMIT: 'main', IMAGE_DIGEST: 'latest', PORT: '0' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      for (const text of [
        'PGPORT must be a port number from 1 to 65535, not "five"',
        'PGSSLMODE must be verify-full',
        '"require"',
        'GIT_COMMIT',
        'IMAGE_DIGEST',
        'PORT must',
      ]) {
        assert.ok(error.message.includes(text), `mentions ${text}`);
      }
      return true;
    },
  );
  assert.throws(
    () => loadConfig({ ...LOCAL, BLOB_CONNECTION_STRING: '', AZURE_CLIENT_ID: 'id', BLOB_ACCOUNT_URL: 'http://plain' }),
    /BLOB_ACCOUNT_URL must be an https:\/\/ URL/,
  );
});

test('the migrate job needs only the database settings', () => {
  const { PGHOST, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE } = LOCAL;
  assert.deepEqual(loadDatabaseConfig({ PGHOST, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE }), {
    host: 'postgres',
    port: 5432,
    database: 'launchtracker',
    user: 'launchtracker',
    tls: false,
    password: 'synthetic-password',
  });
  assert.deepEqual(loadDatabaseConfig({ PGHOST: 'launch.postgres.database.azure.com', PGDATABASE, PGUSER: 'id-lt-migrate', AZURE_CLIENT_ID: 'mi' }), {
    host: 'launch.postgres.database.azure.com',
    port: 5432,
    database: 'launchtracker',
    user: 'id-lt-migrate',
    tls: true,
    clientId: 'mi',
  });
  assert.throws(
    () => loadDatabaseConfig({ PGHOST }),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.startsWith('The Launch Tracker migration cannot start') &&
      ['AZURE_CLIENT_ID', 'PGDATABASE', 'PGUSER'].every(name => error.message.includes(name)) &&
      !error.message.includes('BLOB'),
  );
});
