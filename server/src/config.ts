import { fileURLToPath } from 'node:url';

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
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const problems: string[] = [];
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

  const password = read('PGPASSWORD');
  const connectionString = read('BLOB_CONNECTION_STRING');
  const clientId =
    password && connectionString ? '' : required('AZURE_CLIENT_ID', 'the managed identity that signs in where PGPASSWORD or BLOB_CONNECTION_STRING is absent');

  const sslMode = read('PGSSLMODE') || 'verify-full';
  if (sslMode !== 'verify-full' && sslMode !== 'disable')
    problems.push(`PGSSLMODE must be verify-full, or disable for a database on this machine, not "${sslMode}"`);

  const database: DatabaseConfig = {
    host: required('PGHOST', 'the PostgreSQL server name'),
    port: port('PGPORT', 5432),
    database: required('PGDATABASE', 'the database name'),
    user: required('PGUSER', 'the database user, or the managed identity name in Azure'),
    tls: sslMode !== 'disable',
    ...(password ? { password } : { clientId }),
  };

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
  };
  if (problems.length) throw new ConfigError(`Launch Tracker cannot start:\n  - ${problems.join('\n  - ')}\nSet these in the environment and start it again.`);
  return config;
}
