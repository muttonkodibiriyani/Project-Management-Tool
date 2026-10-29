import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import pg from 'pg';
import type { DatabaseConfig, StorageConfig } from './config.js';
import type { Check } from './health.js';
import { managedIdentity } from './managed-identity.js';

const POSTGRES_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
const TIMEOUT_MS = 5000;

export function createPool(config: DatabaseConfig, onIdleError: (error: Error) => void): pg.Pool {
  let password: string | (() => Promise<string>);
  if ('password' in config) password = config.password;
  else {
    const identity = managedIdentity(config.clientId);
    password = async () => (await identity.getToken(POSTGRES_SCOPE)).token;
  }
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password,
    ssl: config.tls ? { rejectUnauthorized: true } : false,
    max: 10,
    connectionTimeoutMillis: TIMEOUT_MS,
    query_timeout: TIMEOUT_MS,
  });
  // A dropped idle connection (restart, failover) is reported, not fatal: the next query reconnects.
  pool.on('error', onIdleError);
  return pool;
}

export function createContainer(config: StorageConfig): ContainerClient {
  // The SDK's default retries last minutes and end in a timeout that hides the cause; these end within a second.
  const options = { retryOptions: { maxTries: 3, retryDelayInMs: 200, maxRetryDelayInMs: 1000 } };
  const service =
    'connectionString' in config
      ? BlobServiceClient.fromConnectionString(config.connectionString, options)
      : new BlobServiceClient(config.accountUrl, managedIdentity(config.clientId), options);
  return service.getContainerClient(config.container);
}

export function databaseCheck(pool: pg.Pool, config: DatabaseConfig): Check {
  const where = `${config.host}:${config.port}`;
  return {
    name: 'PostgreSQL',
    run: async () => {
      await pool.query('select 1');
    },
    explain: error => {
      const { code, message } = details(error);
      switch (problem(error)) {
        case 'refused':
          return `PostgreSQL refused the connection at ${where}. Check that the database is running and that PGHOST and PGPORT point at it.`;
        case 'unknown host':
          return `PostgreSQL host ${config.host} could not be found. Check PGHOST, and that this network can resolve it (in Azure, the private DNS zone).`;
        case 'timeout':
          return `PostgreSQL at ${where} did not answer within 5 s. Check that the database is running and that the network lets this app reach it (in Azure, the private endpoint).`;
        case 'certificate':
          return `PostgreSQL at ${where} sent a TLS certificate that could not be verified (${message}). Check that PGHOST is the server's own name.`;
      }
      if (code === '28P01' || code === '28000') {
        return `PostgreSQL turned away user ${config.user} (${message}). Check PGUSER and PGPASSWORD, or in Azure that the managed identity has a database role.`;
      }
      if (code === '3D000') return `Database ${config.database} does not exist on ${where}. Check PGDATABASE, or create the database.`;
      if (message.includes('does not support SSL')) {
        return `PostgreSQL at ${where} does not accept TLS. For a database on this machine set PGSSLMODE=disable; in Azure TLS is required.`;
      }
      return `PostgreSQL at ${where} failed the check: ${message}`;
    },
  };
}

/** The first check on an empty account (Azurite starts empty) creates the container; in Azure the deployment creates it. */
export function storageCheck(container: ContainerClient, config: StorageConfig): Check {
  const where = new URL(container.url).host;
  const setting = 'connectionString' in config ? 'BLOB_CONNECTION_STRING' : 'BLOB_ACCOUNT_URL';
  return {
    name: 'Blob storage',
    run: async abortSignal => {
      if (!(await container.exists({ abortSignal }))) await container.createIfNotExists({ abortSignal });
    },
    explain: error => {
      const { code, status, message } = details(error);
      switch (problem(error)) {
        case 'refused':
          return `Blob storage refused the connection at ${where}. Check that the storage service is running and that ${setting} points at it.`;
        case 'unknown host':
          return `Blob storage host ${where} could not be found. Check ${setting}, and that this network can resolve it (in Azure, the private DNS zone).`;
        case 'timeout':
          return `Blob storage at ${where} did not answer within 5 s. Check that it is running and that the network lets this app reach it (in Azure, the private endpoint).`;
        case 'certificate':
          return `Blob storage at ${where} sent a TLS certificate that could not be verified (${message}). Check ${setting}.`;
      }
      if (status === 401 || status === 403) {
        return `Blob storage at ${where} refused access (${code || status}). Check the account key in BLOB_CONNECTION_STRING, or in Azure that the managed identity has Storage Blob Data Contributor on the account.`;
      }
      return `Blob storage at ${where} failed the check: ${message}`;
    },
  };
}

function details(error: unknown): { code: string; status: number; message: string } {
  const fields = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; statusCode?: unknown; message?: unknown; errors?: unknown };
  // A host with several addresses fails with an AggregateError that holds one error per address.
  const first = Array.isArray(fields.errors) ? (fields.errors[0] as { code?: unknown } | undefined) : undefined;
  return {
    code: typeof fields.code === 'string' ? fields.code : typeof first?.code === 'string' ? first.code : '',
    status: typeof fields.statusCode === 'number' ? fields.statusCode : 0,
    message: typeof fields.message === 'string' && fields.message ? fields.message : String(error),
  };
}

function problem(error: unknown): 'refused' | 'unknown host' | 'timeout' | 'certificate' | null {
  const { code, message } = details(error);
  const name = error instanceof Error ? error.name : '';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'unknown host';
  if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT' || /timeout|timed out/i.test(message)) return 'timeout';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/.test(code)) return 'certificate';
  return null;
}
