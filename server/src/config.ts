import { fileURLToPath } from 'node:url';
import { isProduction, loadAuthConfig, type AuthConfig } from './auth/config.js';

/**
 * Settings come only from the environment, so one image runs unchanged on a laptop and in Azure.
 * Locally the services take a password and a connection string; in Azure the app signs in to both
 * with its user-assigned managed identity (AZURE_CLIENT_ID) and holds no secret.
 */
export type DatabaseConfig = {
  host: string;
  port: number;
  database: string;
  user: string;
  tls: boolean;
} & ({ password: string } | { clientId: string });

export type StorageConfig = { container: string } & ({ connectionString: string } | { accountUrl: string; clientId: string });

export interface Config {
  port: number;
  publicDir: string;
  commit: string | null;
  imageDigest: string | null;
  database: DatabaseConfig;
  storage: StorageConfig;
  auth: AuthConfig;
}

export class ConfigError extends Error {}

type Problems = string[];

function reader(env: NodeJS.ProcessEnv, problems: Problems) {
  const read = (name: string) => env[name]?.trim() ?? '';
  const required = (name: string, what: string) => {
    const value = read(name);
    if (!value) problems.push(`${name} is not set (${what})`);
    return value;
  };
  const port = (name: string, fallback: number) => {
    const value = read(name);
    if (!value) return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 65535) problems.push(`${name} must be a port number from 1 to 65535, not "${value}"`);
    return number;
  };
  const matching = (name: string, pattern: RegExp, what: string) => {
    const value = read(name);
    if (value && !pattern.test(value)) problems.push(`${name} must be ${what}, not "${value}"`);
    return value || null;
  };
  return { read, required, port, matching };
}

function readDatabase(env: NodeJS.ProcessEnv, problems: Problems, clientId: () => string): DatabaseConfig {
  const { read, required, port } = reader(env, problems);
  const password = read('PGPASSWORD');
  const sslMode = read('PGSSLMODE') || 'verify-full';
  if (sslMode !== 'verify-full' && sslMode !== 'disable')
    problems.push(`PGSSLMODE must be verify-full, or disable for a database on this machine, not "${sslMode}"`);
  return {
    host: required('PGHOST', 'the PostgreSQL server name'),
    port: port('PGPORT', 5432),
    database: required('PGDATABASE', 'the database name'),
    user: required('PGUSER', 'the database user, or the managed identity name in Azure'),
    tls: sslMode !== 'disable',
    ...(password ? { password } : { clientId: clientId() }),
  };
}

function stopIf(problems: Problems, what: string) {
  if (problems.length) throw new ConfigError(`${what} cannot start:\n  - ${problems.join('\n  - ')}\nSet these in the environment and start it again.`);
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: Problems = [];
  const { read, required, port, matching } = reader(env, problems);

  const connectionString = read('BLOB_CONNECTION_STRING');
  if (connectionString && isProduction(env)) {
    problems.push(
      'BLOB_CONNECTION_STRING holds a storage account key, which is refused where CONTAINER_APP_NAME or NODE_ENV=production is set. Set BLOB_ACCOUNT_URL and AZURE_CLIENT_ID instead',
    );
  }
  const clientId =
    read('PGPASSWORD') && connectionString
      ? ''
      : required('AZURE_CLIENT_ID', 'the managed identity that signs in where PGPASSWORD or BLOB_CONNECTION_STRING is absent');
  const database = readDatabase(env, problems, () => clientId);

  const container = required('BLOB_CONTAINER', 'the Blob container for uploaded files');
  let storage: StorageConfig = { container, connectionString };
  if (!connectionString) {
    const accountUrl = read('BLOB_ACCOUNT_URL');
    if (!accountUrl) problems.push('BLOB_CONNECTION_STRING or BLOB_ACCOUNT_URL must be set (local storage, or the storage account in Azure)');
    else if (!URL.canParse(accountUrl) || new URL(accountUrl).protocol !== 'https:')
      problems.push(`BLOB_ACCOUNT_URL must be an https:// URL, not "${accountUrl}"`);
    storage = { container, accountUrl, clientId };
  }

  const config: Config = {
    port: port('PORT', 8080),
    publicDir: read('PUBLIC_DIR') || fileURLToPath(new URL('../public/', import.meta.url)),
    commit: matching('GIT_COMMIT', /^[0-9a-f]{40}$/, 'a full 40-character commit hash'),
    imageDigest: matching('IMAGE_DIGEST', /^sha256:[0-9a-f]{64}$/, 'an image digest like sha256:<64 hex characters>'),
    database,
    storage,
    auth: loadAuthConfig(env, problems),
  };
  stopIf(problems, 'Launch Tracker');
  return config;
}

/** The migrate job needs only the database: PG* settings, or AZURE_CLIENT_ID for its managed identity in Azure. */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv): DatabaseConfig {
  const problems: Problems = [];
  const { required } = reader(env, problems);
  const database = readDatabase(env, problems, () => required('AZURE_CLIENT_ID', 'the managed identity that signs in where PGPASSWORD is absent'));
  stopIf(problems, 'The Launch Tracker migration');
  return database;
}
