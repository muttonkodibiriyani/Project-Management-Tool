import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { TokenSource } from '../managed-identity.js';
import { knownRoles } from './roles.js';
import type { Identity } from './sessions.js';

/** Why a sign-in was refused; each has its own page (REFUSALS in plugin.ts). */
export type SignInRefusal = 'state_mismatch' | 'not_in_tenant' | 'guest_not_allowed' | 'no_role' | 'account_disabled' | 'account_conflict' | 'entra_error';

export class SignInError extends Error {
  constructor(
    readonly code: SignInRefusal,
    /** For the log only: never shown to the user, and never holds a token. */
    readonly reason: string,
  ) {
    super(`${code}: ${reason}`);
  }
}

export interface EntraSettings {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  /** The app's managed identity, which the app registration trusts as a federated credential. */
  assertion: TokenSource;
}

/** What the sign-in cookie carries between /auth/login and /auth/callback. */
export interface PendingSignIn {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
}

const AUTHORITY = 'https://login.microsoftonline.com';
const TOKEN_EXCHANGE = 'api://AzureADTokenExchange';
const TIMEOUT_MS = 10_000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function entraClient(settings: EntraSettings, keys?: JWTVerifyGetKey, fetchToken: typeof fetch = fetch) {
  const { tenantId, clientId, redirectUri, assertion } = settings;
  const base = `${AUTHORITY}/${tenantId}`;
  const issuer = `${base}/v2.0`;
  const signingKeys = keys ?? createRemoteJWKSet(new URL(`${base}/discovery/v2.0/keys`), { timeoutDuration: TIMEOUT_MS });

  return {
    issuer,

    logoutUrl(postLogoutRedirectUri: string): string {
      return `${base}/oauth2/v2.0/logout?${new URLSearchParams({ post_logout_redirect_uri: postLogoutRedirectUri }).toString()}`;
    },

    start(returnTo: string): { pending: PendingSignIn; url: string } {
      const pending = { state: random(), nonce: random(), verifier: random(), returnTo };
      const url = new URL(`${base}/oauth2/v2.0/authorize`);
      url.search = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        response_mode: 'form_post',
        redirect_uri: redirectUri,
        scope: 'openid profile email',
        state: pending.state,
        nonce: pending.nonce,
        code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
        code_challenge_method: 'S256',
      }).toString();
      return { pending, url: url.toString() };
    },

    async finish(code: string, pending: PendingSignIn): Promise<Identity> {
      let clientAssertion: string;
      try {
        clientAssertion = (await assertion.getToken(TOKEN_EXCHANGE)).token;
      } catch (error) {
        throw new SignInError('entra_error', `no managed identity token for the client assertion: ${message(error)}`);
      }

      let response: Response;
      try {
        response = await fetchToken(`${base}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            code,
            redirect_uri: redirectUri,
            code_verifier: pending.verifier,
            client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
            client_assertion: clientAssertion,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw new SignInError('entra_error', `the Entra token endpoint could not be reached: ${message(error)}`);
      }
      const body = (await response.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown; error_codes?: unknown };
      if (!response.ok || typeof body.id_token !== 'string') {
        // Entra's error and AADSTS codes say what is wrong; its description can name the user, so it stays out.
        throw new SignInError(
          'entra_error',
          `the Entra token endpoint answered ${response.status} ${typeof body.error === 'string' ? body.error : ''} ${JSON.stringify(body.error_codes ?? [])}`,
        );
      }
      return verifyIdToken(body.id_token, pending.nonce);
    },
  };

  async function verifyIdToken(idToken: string, nonce: string): Promise<Identity> {
    let claims: Record<string, unknown>;
    try {
      claims = (await jwtVerify(idToken, signingKeys, { audience: clientId, algorithms: ['RS256'], clockTolerance: 60 })).payload;
    } catch (error) {
      throw new SignInError('entra_error', `the ID token failed verification: ${error instanceof errors.JOSEError ? error.code : message(error)}`);
    }
    // A token for another tenant is signed by the same Microsoft keys, so the issuer and tid are what keep it out.
    if (claims.iss !== issuer || claims.tid !== tenantId) {
      throw new SignInError('not_in_tenant', `the token is from tenant ${String(claims.tid)}, not ${tenantId}`);
    }
    if (claims.nonce !== nonce) throw new SignInError('state_mismatch', 'the ID token nonce does not match this sign-in');
    if (claims.acct === 1) throw new SignInError('guest_not_allowed', `user ${String(claims.oid)} is a guest in the tenant`);
    if (claims.acct !== 0) {
      throw new SignInError(
        'entra_error',
        'the ID token has no acct claim; add the optional claim acct to the app registration (architecture doc section 4.2)',
      );
    }
    const roles = knownRoles(claims.roles);
    if (roles.length === 0) throw new SignInError('no_role', `user ${String(claims.oid)} has no Launch Tracker app role`);
    const email = typeof claims.email === 'string' ? claims.email : claims.preferred_username;
    if (typeof claims.oid !== 'string' || !GUID.test(claims.oid) || typeof email !== 'string') {
      throw new SignInError('entra_error', 'the ID token has no oid or e-mail; add the optional claim email to the app registration');
    }
    return { oid: claims.oid, tenantId, email, name: typeof claims.name === 'string' ? claims.name : email, roles };
  }
}

export type EntraClient = ReturnType<typeof entraClient>;

const random = () => randomBytes(32).toString('base64url');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
