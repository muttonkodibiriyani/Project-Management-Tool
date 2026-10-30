import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { recordingSessions } from '../testing/sessions.js';
import { DEV_TENANT_ID, DEV_USERS } from './dev-users.js';
import { entraClient, SignInError } from './entra.js';
import { installAuth, safeReturnTo, SESSION_COOKIE, type AuthOptions } from './plugin.js';
import { APP_ROLES } from './roles.js';
import type { SessionWriter } from './sessions.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://launch.example.test';
const MI_ASSERTION = 'synthetic-managed-identity-assertion';
const CSRF = { 'x-requested-with': 'launch-tracker' };

const signer = await generateKeyPair('RS256');
const stranger = await generateKeyPair('RS256');
const jwk: JWK = { ...(await exportJWK(signer.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const keys = createLocalJWKSet({ keys: [jwk] });

function authApp(options: AuthOptions): FastifyInstance {
  const app = Fastify();
  installAuth(app, options);
  return app;
}

function devApp(sessions: SessionWriter = recordingSessions().writer): FastifyInstance {
  return authApp({ mode: 'dev', sessions, signingKey: randomBytes(32) });
}

const cookieOf = (response: LightMyRequestResponse, name: string) => response.cookies.find(cookie => cookie.name === name);

test('the test identity provider signs in one synthetic user per role, in the test tenant', async () => {
  const { writer, started } = recordingSessions();
  const app = devApp(writer);
  for (const user of DEV_USERS) {
    const response = await app.inject({ url: `/auth/dev-login?email=${encodeURIComponent(user.email)}`, headers: { 'user-agent': 'synthetic-browser' } });
    assert.equal(response.statusCode, 302, user.email);
    assert.equal(cookieOf(response, SESSION_COOKIE)?.value, started.at(-1)?.token);
  }
  assert.deepEqual(
    started.map(({ identity }) => identity.roles),
    APP_ROLES.map(role => [role]),
  );
  assert.ok(
    started.every(
      ({ identity, visitor }) => identity.tenantId === DEV_TENANT_ID && identity.email.endsWith('@example.test') && visitor.userAgent === 'synthetic-browser',
    ),
  );
});

test('the test identity provider refuses anyone else, and Entra routes are absent', async () => {
  const { writer, started } = recordingSessions();
  const app = devApp(writer);
  const unknown = await app.inject('/auth/dev-login?email=someone@corp.example');
  assert.equal(unknown.statusCode, 403);
  assert.match(unknown.body, /viewer@example\.test \(Viewer\)/);
  assert.equal(cookieOf(unknown, SESSION_COOKIE), undefined);
  assert.equal(started.length, 0);
  assert.equal((await app.inject('/auth/login')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/callback' })).statusCode, 404);

  const session = await app.inject('/auth/dev-login?email=Manager@Example.test&returnTo=/%23/p/QAT');
  assert.equal(session.headers.location, '/#/p/QAT');
  const cookie = cookieOf(session, SESSION_COOKIE);
  assert.deepEqual([cookie?.httpOnly, cookie?.secure, cookie?.sameSite, cookie?.path], [true, true, 'Lax', '/']);
});

test('sign-out needs the CSRF header, ends the session and clears the cookie', async () => {
  const { writer, started, ended } = recordingSessions();
  const app = devApp(writer);
  const signedIn = await app.inject('/auth/dev-login?email=brand@example.test');
  const cookie = `${SESSION_COOKIE}=${cookieOf(signedIn, SESSION_COOKIE)?.value ?? ''}`;

  const refused = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json<{ code: string }>().code, 'csrf_header_missing');
  assert.deepEqual(ended, []);

  const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, ...CSRF } });
  assert.equal(out.statusCode, 200);
  assert.deepEqual(out.json(), { entraLogoutUrl: null });
  assert.equal(cookieOf(out, SESSION_COOKIE)?.value, '');
  assert.deepEqual(ended, [started[0]?.token]);

  const again = await app.inject({ method: 'POST', url: '/auth/logout', headers: CSRF });
  assert.equal(again.statusCode, 200, 'signing out without a session still answers');
  assert.equal(ended.length, 1);
});

test('a turned-off account gets a plain refusal and no cookie', async () => {
  const sessions: SessionWriter = {
    start: () => Promise.reject(new SignInError('account_disabled', 'synthetic')),
    end: () => Promise.resolve(),
  };
  const response = await devApp(sessions).inject('/auth/dev-login?email=viewer@example.test');
  assert.equal(response.statusCode, 403);
  assert.match(response.body, /has been turned off/);
  assert.equal(cookieOf(response, SESSION_COOKIE), undefined);
});

test('returnTo stays on this site', () => {
  assert.equal(safeReturnTo('/#/p/QAT?tab=lines'), '/#/p/QAT?tab=lines');
  for (const hostile of [
    '//evil.example',
    '/\\evil.example',
    '/.//evil.example',
    'https://evil.example/',
    '/\t/evil.example',
    'javascript:alert(1)',
    undefined,
  ]) {
    assert.equal(safeReturnTo(hostile), '/', String(hostile));
  }
});

// ---------- Entra ----------

interface TokenRequest {
  url: string;
  body: URLSearchParams;
}

function entraApp(claims: (nonce: string) => Record<string, unknown>, sign: CryptoKey = signer.privateKey) {
  const requests: TokenRequest[] = [];
  let nonce = '';
  const fetchToken = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: url instanceof Request ? url.url : url.toString(), body: new URLSearchParams(init?.body as URLSearchParams) });
    const idToken = await new SignJWT(claims(nonce)).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuedAt().setExpirationTime('1h').sign(sign);
    return Response.json({ id_token: idToken, token_type: 'Bearer' });
  }) as typeof fetch;
  const entra = entraClient(
    {
      tenantId: TENANT,
      clientId: CLIENT,
      redirectUri: `${ORIGIN}/auth/callback`,
      assertion: { getToken: () => Promise.resolve({ token: MI_ASSERTION, expiresOnTimestamp: Date.now() + 3_600_000 }) },
    },
    keys,
    fetchToken,
  );
  const { writer, started } = recordingSessions();
  const app = authApp({ mode: 'entra', sessions: writer, signingKey: randomBytes(32), publicOrigin: ORIGIN, entra });

  const signIn = async (returnTo = '/#/home', change: (form: Record<string, string>) => void = () => undefined) => {
    const login = await app.inject(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
    const authorize = new URL(login.headers.location ?? '');
    nonce = authorize.searchParams.get('nonce') ?? '';
    const pending = cookieOf(login, '__Host-lt_auth');
    const form: Record<string, string> = { code: 'synthetic-code', state: authorize.searchParams.get('state') ?? '' };
    change(form);
    const callback = await app.inject({
      method: 'POST',
      url: '/auth/callback',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: pending ? `${pending.name}=${pending.value}` : '' },
      payload: new URLSearchParams(form).toString(),
    });
    return { login, authorize, pending, callback };
  };
  return { app, requests, started, signIn };
}

const goodClaims =
  (overrides: Record<string, unknown> = {}) =>
  (nonce: string) => ({
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: CLIENT,
    tid: TENANT,
    oid: '44444444-4444-4444-8444-444444444444',
    email: 'lily@corp.example',
    name: 'Lily Synthetic',
    acct: 0,
    roles: ['BrandTeam'],
    nonce,
    ...overrides,
  });

test('sign-in goes to the configured tenant with PKCE and no client secret', async () => {
  const { app, requests, started, signIn } = entraApp(goodClaims());
  const { authorize, pending, callback } = await signIn('/#/p/QAT');

  assert.equal(authorize.origin + authorize.pathname, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
  for (const [name, value] of Object.entries({
    client_id: CLIENT,
    response_type: 'code',
    response_mode: 'form_post',
    redirect_uri: `${ORIGIN}/auth/callback`,
    scope: 'openid profile email',
    code_challenge_method: 'S256',
  })) {
    assert.equal(authorize.searchParams.get(name), value, name);
  }
  assert.deepEqual([pending?.httpOnly, pending?.secure, pending?.sameSite], [true, true, 'None']);
  assert.ok(!pending?.value.includes(authorize.searchParams.get('state') ?? '-'), 'the sign-in cookie is sealed');

  assert.equal(callback.statusCode, 302);
  assert.equal(callback.headers.location, '/#/p/QAT');
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.equal(request.body.get('client_assertion'), MI_ASSERTION);
  assert.equal(request.body.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
  assert.equal(request.body.get('client_secret'), null);
  const verifier = request.body.get('code_verifier') ?? '';
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));

  const session = cookieOf(callback, SESSION_COOKIE);
  assert.equal(session?.value, started[0]?.token);
  assert.deepEqual(started[0]?.identity, {
    oid: '44444444-4444-4444-8444-444444444444',
    tenantId: TENANT,
    email: 'lily@corp.example',
    name: 'Lily Synthetic',
    roles: ['BrandTeam'],
  });

  const cookie = `${SESSION_COOKIE}=${session?.value ?? ''}`;
  const out = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, ...CSRF } });
  assert.equal(
    out.json<{ entraLogoutUrl: string }>().entraLogoutUrl,
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout?post_logout_redirect_uri=${encodeURIComponent(`${ORIGIN}/`)}`,
  );
});

const REFUSED: [string, ReturnType<typeof entraApp>, number, RegExp, ((form: Record<string, string>) => void)?][] = [
  [
    'another tenant',
    entraApp(goodClaims({ iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0`, tid: OTHER_TENANT })),
    403,
    /Only work accounts in the company/,
  ],
  ['a token naming another tenant under our issuer', entraApp(goodClaims({ tid: OTHER_TENANT })), 403, /Only work accounts/],
  ['a guest', entraApp(goodClaims({ acct: 1 })), 403, /Guest accounts cannot use Launch Tracker/],
  ['no Launch Tracker role', entraApp(goodClaims({ roles: [] })), 403, /no Launch Tracker role/],
  ['only unknown roles', entraApp(goodClaims({ roles: ['Global.Admin'] })), 403, /no Launch Tracker role/],
  ['another app', entraApp(goodClaims({ aud: OTHER_TENANT })), 502, /could not complete the sign-in/],
  ['a forged signature', entraApp(goodClaims(), stranger.privateKey), 502, /could not complete/],
  ['a replayed nonce', entraApp(() => goodClaims()('old-nonce')), 400, /Start it again/],
  ['no acct claim', entraApp(goodClaims({ acct: undefined })), 502, /could not complete/],
  ['an oid that is not a GUID', entraApp(goodClaims({ oid: 'not-a-guid' })), 502, /could not complete/],
  [
    'a forged state',
    entraApp(goodClaims()),
    400,
    /Start it again/,
    form => {
      form.state = 'forged';
    },
  ],
  [
    'an Entra error',
    entraApp(goodClaims()),
    502,
    /could not complete/,
    form => {
      form.error = 'access_denied';
    },
  ],
];

for (const [what, { started, signIn }, status, text, change] of REFUSED) {
  test(`sign-in is refused with a plain page for ${what}`, async () => {
    const { callback } = await signIn('/', change);
    assert.equal(callback.statusCode, status);
    assert.match(callback.headers['content-type'] ?? '', /^text\/html/);
    assert.match(callback.body, text);
    assert.doesNotMatch(callback.body, /<script|style=/);
    assert.equal(cookieOf(callback, SESSION_COOKIE), undefined);
    assert.equal(started.length, 0, 'no session was written');
  });
}

test('the callback refuses a post that did not start here', async () => {
  const { app } = entraApp(goodClaims());
  const response = await app.inject({
    method: 'POST',
    url: '/auth/callback',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: 'code=synthetic-code&state=anything',
  });
  assert.equal(response.statusCode, 400);
  assert.equal(cookieOf(response, SESSION_COOKIE), undefined);
  assert.equal((await app.inject('/auth/dev-login?email=admin@example.test')).statusCode, 404, 'no test sign-in under Entra');
});
