import { randomBytes } from 'node:crypto';

/**
 * AUTH_MODE=entra signs work accounts in through the company's Entra tenant. AUTH_MODE=dev is the
 * test identity provider for laptops and CI: synthetic users, no tenant. Azure Container Apps always
 * sets CONTAINER_APP_NAME, so the dev provider cannot start there, nor anywhere NODE_ENV=production.
 */
export type AuthConfig =
  | { mode: 'dev'; signingKey: Buffer }
  | {
      mode: 'entra';
      tenantId: string;
      clientId: string;
      /** The app's own https origin; the redirect URI is this plus /auth/callback. */
      publicOrigin: string;
      /** The managed identity that is the app registration's federated credential: sign-in holds no secret. */
      managedIdentityClientId: string;
      signingKey: Buffer;
    };

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isProduction(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.CONTAINER_APP_NAME?.trim()) || env.NODE_ENV?.trim() === 'production';
}

export function loadAuthConfig(env: NodeJS.ProcessEnv, problems: string[]): AuthConfig {
  const read = (name: string) => env[name]?.trim() ?? '';
  const mode = read('AUTH_MODE');

  if (mode === 'dev') {
    if (isProduction(env)) {
      problems.push(
        'AUTH_MODE=dev is the test sign-in for laptops and CI and is refused where CONTAINER_APP_NAME or NODE_ENV=production is set. Set AUTH_MODE=entra',
      );
    }
    return { mode, signingKey: randomBytes(32) };
  }
  if (mode !== 'entra') {
    problems.push(`AUTH_MODE must be entra (Microsoft Entra sign-in) or dev (synthetic users, local only), not "${mode}"`);
    return { mode: 'dev', signingKey: randomBytes(32) };
  }

  const guid = (name: string, what: string) => {
    const value = read(name);
    if (!value) problems.push(`${name} is not set (${what})`);
    else if (!GUID.test(value)) problems.push(`${name} must be a GUID like 00000000-0000-0000-0000-000000000000 (${what})`);
    return value.toLowerCase();
  };
  const tenantId = guid('ENTRA_TENANT_ID', 'the company Entra tenant ID');
  const clientId = guid('ENTRA_CLIENT_ID', "the app registration's client ID");
  const managedIdentityClientId = guid('AZURE_CLIENT_ID', "the managed identity that is the app registration's federated credential");

  const origin = read('PUBLIC_ORIGIN');
  let publicOrigin = '';
  if (!origin) problems.push('PUBLIC_ORIGIN is not set (the https address people open the app at, which Entra redirects back to)');
  else if (!URL.canParse(origin) || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin.replace(/\/$/, '')) {
    problems.push(`PUBLIC_ORIGIN must be an https:// origin with no path, like https://launch.example.com, not "${origin}"`);
  } else publicOrigin = new URL(origin).origin;

  // Delivered from Key Vault as a secret reference; never logged.
  const signingKey = Buffer.from(read('SESSION_SIGNING_KEY'), 'base64');
  if (signingKey.length < 32) problems.push('SESSION_SIGNING_KEY must be at least 32 random bytes, base64-encoded (the Key Vault secret session-signing-key)');

  return { mode, tenantId, clientId, publicOrigin, managedIdentityClientId, signingKey };
}
