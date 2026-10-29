import assert from 'node:assert/strict';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { after, test } from 'node:test';
import type { DatabaseConfig, StorageConfig } from './config.js';
import { createContainer, createPool, databaseCheck, storageCheck } from './dependencies.js';
import type { Check } from './health.js';

const servers: Server[] = [];
after(() => {
  for (const server of servers) server.close();
});

/** A port where nothing listens. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** A port that answers PostgreSQL's TLS request with "no". */
async function noTlsPort(): Promise<number> {
  const server = createServer(socket => socket.once('data', () => socket.write('N')));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function failure(check: Check): Promise<string> {
  try {
    await check.run(AbortSignal.timeout(5000));
  } catch (error) {
    return check.explain(error);
  }
  assert.fail(`${check.name} passed its check but should have failed`);
}

const database = (host: string, port: number, tls = false): DatabaseConfig => ({
  host,
  port,
  database: 'launchtracker',
  user: 'launchtracker',
  tls,
  password: 'synthetic',
});
const postgres = (config: DatabaseConfig) =>
  databaseCheck(
    createPool(config, () => {}),
    config,
  );
const storage = (endpoint: string): StorageConfig => ({
  container: 'files',
  connectionString: `DefaultEndpointsProtocol=http;AccountName=launchtracker;AccountKey=c3ludGhldGlj;BlobEndpoint=${endpoint}/launchtracker;`,
});
const blob = (config: StorageConfig) => storageCheck(createContainer(config), config);

test('PostgreSQL that is not running is named, with where it was looked for', async () => {
  const port = await closedPort();
  assert.equal(
    await failure(postgres(database('127.0.0.1', port))),
    `PostgreSQL refused the connection at 127.0.0.1:${port}. Check that the database is running and that PGHOST and PGPORT point at it.`,
  );
});

test('a PostgreSQL host that does not exist is named', async () => {
  assert.match(await failure(postgres(database('postgres.invalid', 5432))), /^PostgreSQL host postgres\.invalid could not be found\. Check PGHOST/);
});

test('PostgreSQL without TLS is explained when TLS is required', async () => {
  const port = await noTlsPort();
  assert.match(await failure(postgres(database('127.0.0.1', port, true))), /does not accept TLS\. For a database on this machine set PGSSLMODE=disable/);
});

test('PostgreSQL turning the user away, a missing database and a timeout are explained', () => {
  const check = databaseCheck(
    createPool(database('postgres', 5432), () => {}),
    database('postgres', 5432),
  );
  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
  assert.match(
    check.explain(pgError('28P01', 'password authentication failed for user "launchtracker"')),
    /turned away user launchtracker .*Check PGUSER and PGPASSWORD/,
  );
  assert.match(check.explain(pgError('3D000', 'database "launchtracker" does not exist')), /^Database launchtracker does not exist on postgres:5432/);
  assert.match(check.explain(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), /did not answer within 5 s/);
});

test('Blob storage that is not running is named, with where it was looked for', async () => {
  const port = await closedPort();
  assert.match(
    await failure(blob(storage(`http://127.0.0.1:${port}`))),
    new RegExp(`^Blob storage refused the connection at 127\\.0\\.0\\.1:${port}\\. Check that the storage service is running and that BLOB_CONNECTION_STRING`),
  );
});

test('a Blob storage host that does not exist is named', async () => {
  assert.match(
    await failure(blob(storage('http://storage.invalid:10000'))),
    /^Blob storage host storage\.invalid:10000 could not be found\. Check BLOB_CONNECTION_STRING,/,
  );
});

test('Blob storage refusing the key is explained', () => {
  const check = blob(storage('http://azurite:10000'));
  const denied = Object.assign(new Error('Server failed to authenticate the request.'), { statusCode: 403, code: 'AuthorizationFailure' });
  assert.match(check.explain(denied), /^Blob storage at azurite:10000 refused access \(AuthorizationFailure\)\. Check the account key/);
});
