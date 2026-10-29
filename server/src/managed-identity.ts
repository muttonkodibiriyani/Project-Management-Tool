/**
 * Access tokens for the app's user-assigned managed identity, from the endpoint Azure Container Apps
 * gives every container with an identity (IDENTITY_ENDPOINT and IDENTITY_HEADER). Written here rather
 * than taken from @azure/identity, whose msal-node dependency carries a high advisory
 * (GHSA-xcx6-jx8p-x3h5) with no fixed release in the range it accepts.
 */
export interface AccessToken {
  token: string;
  expiresOnTimestamp: number;
}

export interface TokenSource {
  getToken(scopes: string | string[]): Promise<AccessToken>;
}

/** Fetch a new token this long before the cached one expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export function managedIdentity(clientId: string, env: NodeJS.ProcessEnv = process.env, fetchToken: typeof fetch = fetch): TokenSource {
  const cache = new Map<string, AccessToken>();
  return {
    async getToken(scopes) {
      const resource = (Array.isArray(scopes) ? scopes.join(' ') : scopes).replace(/\/\.default$/, '');
      const cached = cache.get(resource);
      if (cached && cached.expiresOnTimestamp - Date.now() > REFRESH_MARGIN_MS) return cached;

      const endpoint = env.IDENTITY_ENDPOINT;
      const secret = env.IDENTITY_HEADER;
      if (!endpoint || !secret) {
        throw new Error(
          'No managed identity is available here (IDENTITY_ENDPOINT and IDENTITY_HEADER are not set). ' +
            'In Azure, assign the identity to the container app; on a laptop, set PGPASSWORD and BLOB_CONNECTION_STRING instead.',
        );
      }
      const url = new URL(endpoint);
      url.searchParams.set('api-version', '2019-08-01');
      url.searchParams.set('resource', resource);
      url.searchParams.set('client_id', clientId);
      const response = await fetchToken(url, { headers: { 'X-IDENTITY-HEADER': secret }, signal: AbortSignal.timeout(5000) });
      const body = (await response.json().catch(() => ({}))) as { access_token?: unknown; expires_on?: unknown };
      const expiresOnTimestamp = Number(body.expires_on) * 1000;
      if (!response.ok || typeof body.access_token !== 'string' || !Number.isFinite(expiresOnTimestamp)) {
        throw new Error(
          `The managed identity endpoint gave no token for ${resource} (HTTP ${response.status}). ` +
            `Check that the identity with client ID ${clientId} is assigned to the container app.`,
        );
      }
      const token = { token: body.access_token, expiresOnTimestamp };
      cache.set(resource, token);
      return token;
    },
  };
}
