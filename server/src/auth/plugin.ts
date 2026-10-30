import fastifyCookie, { type CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hkdfSync } from 'node:crypto';
import { EncryptJWT, jwtDecrypt } from 'jose';
import { sendProblem } from '../problem.js';
import { DEV_USERS } from './dev-users.js';
import { SignInError, type EntraClient, type PendingSignIn, type SignInRefusal } from './entra.js';
import type { Identity, SessionWriter } from './sessions.js';

export type AuthOptions = { sessions: SessionWriter; signingKey: Buffer } & ({ mode: 'dev' } | { mode: 'entra'; publicOrigin: string; entra: EntraClient });

export const SESSION_COOKIE = '__Host-lt_session';
const PENDING_COOKIE = '__Host-lt_auth';
const PENDING_MINUTES = 10;
/** Sign-out, like every API change, must carry this header; no CORS headers are sent, so no other origin can add it. */
export const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'launch-tracker';

const sessionCookie: CookieSerializeOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
// Entra posts the callback from its own site, so this cookie must be SameSite=None to come back with it.
// It is encrypted, lives 10 minutes and is cleared on first use; the state inside it is what stops forgery.
const pendingCookie: CookieSerializeOptions = { httpOnly: true, secure: true, sameSite: 'none', path: '/' };

/**
 * The sign-in routes: they create and end sessions. The API plugin reads the session on each
 * /api/v1 request and checks the caller's role there.
 */
export function installAuth(app: FastifyInstance, options: AuthOptions): void {
  const { sessions } = options;
  const pendingKey = new Uint8Array(hkdfSync('sha256', options.signingKey, Buffer.alloc(0), 'launch-tracker sign-in cookie', 32));

  const startSession = async (request: FastifyRequest, reply: FastifyReply, identity: Identity, returnTo: string) => {
    const { token, expiresAt } = await sessions.start(identity, { userAgent: request.headers['user-agent'] ?? null, ip: request.ip });
    return reply.setCookie(SESSION_COOKIE, token, { ...sessionCookie, expires: expiresAt }).redirect(returnTo, 302);
  };

  const refuse = (request: FastifyRequest, reply: FastifyReply, error: SignInError) => {
    request.log.warn({ refusal: error.code, reason: error.reason }, 'sign-in refused');
    const page = REFUSALS[error.code];
    return reply
      .code(page.status)
      .type('text/html; charset=utf-8')
      .send(refusalPage(page.title, page.text.replace('{request}', request.id), options.mode === 'entra' ? '/auth/login' : '/auth/dev-login'));
  };

  // Scoped to these routes: the API plugin registers its own cookie parser for /api/v1.
  void app.register(async auth => {
    await auth.register(fastifyCookie);

    // Entra answers with an HTML form post (response_mode=form_post).
    auth.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });

    // Signing out twice, or after the session ended, still clears the cookie and answers the same.
    auth.post('/auth/logout', async (request, reply) => {
      if (request.headers[CSRF_HEADER] !== CSRF_VALUE) {
        return sendProblem(
          request,
          reply,
          403,
          'csrf_header_missing',
          'Request refused',
          `Sign-out must send the header X-Requested-With: ${CSRF_VALUE}. Reload the app and try again.`,
        );
      }
      const token = request.cookies[SESSION_COOKIE];
      if (token) await sessions.end(token);
      reply.clearCookie(SESSION_COOKIE, sessionCookie);
      return { entraLogoutUrl: options.mode === 'entra' ? options.entra.logoutUrl(`${options.publicOrigin}/`) : null };
    });

    if (options.mode === 'entra') {
      const { entra } = options;

      auth.get<{ Querystring: { returnTo?: string } }>('/auth/login', async (request, reply) => {
        const { pending, url } = entra.start(safeReturnTo(request.query.returnTo));
        const sealed = await new EncryptJWT({ ...pending })
          .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
          .setIssuedAt()
          .setExpirationTime(`${PENDING_MINUTES}m`)
          .encrypt(pendingKey);
        return reply.setCookie(PENDING_COOKIE, sealed, { ...pendingCookie, maxAge: PENDING_MINUTES * 60 }).redirect(url, 302);
      });

      auth.post('/auth/callback', async (request, reply) => {
        const body = (typeof request.body === 'object' && request.body !== null ? request.body : {}) as Record<string, unknown>;
        const sealed = request.cookies[PENDING_COOKIE];
        reply.clearCookie(PENDING_COOKIE, pendingCookie);
        try {
          const pending = sealed ? await openPending(sealed, pendingKey) : null;
          if (!pending || typeof body.state !== 'string' || body.state !== pending.state) {
            throw new SignInError('state_mismatch', sealed ? 'the state does not match the sign-in cookie' : 'no sign-in cookie came back');
          }
          if (typeof body.error === 'string') throw new SignInError('entra_error', `Entra answered ${body.error.slice(0, 100)}`);
          if (typeof body.code !== 'string' || !body.code) throw new SignInError('entra_error', 'Entra sent no authorization code');
          return await startSession(request, reply, await entra.finish(body.code, pending), pending.returnTo);
        } catch (error) {
          if (error instanceof SignInError) return refuse(request, reply, error);
          throw error;
        }
      });
    } else {
      auth.get<{ Querystring: { email?: string; returnTo?: string } }>('/auth/dev-login', async (request, reply) => {
        const email = (request.query.email ?? '').trim().toLowerCase();
        const identity = DEV_USERS.find(user => user.email === email);
        if (!identity) {
          return reply
            .code(403)
            .type('text/html; charset=utf-8')
            .send(
              refusalPage(
                'Pick a test user',
                `This is the test sign-in for local runs. Open /auth/dev-login?email= with one of: ${DEV_USERS.map(user => `${user.email} (${user.roles.join(', ')})`).join('; ')}.`,
                null,
              ),
            );
        }
        try {
          return await startSession(request, reply, identity, safeReturnTo(request.query.returnTo));
        } catch (error) {
          if (error instanceof SignInError) return refuse(request, reply, error);
          throw error;
        }
      });
    }
  });
}

/** Only paths on this site; anything else, including //host and /\host, goes to the home page. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048) return '/';
  const url = new URL(value, 'https://launch-tracker.invalid');
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (url.origin !== 'https://launch-tracker.invalid' || path.startsWith('//') || path.startsWith('/\\')) return '/';
  return path;
}

async function openPending(sealed: string, key: Uint8Array): Promise<PendingSignIn | null> {
  try {
    const { payload } = await jwtDecrypt(sealed, key, { maxTokenAge: `${PENDING_MINUTES}m` });
    const { state, nonce, verifier, returnTo } = payload;
    if (typeof state !== 'string' || typeof nonce !== 'string' || typeof verifier !== 'string' || typeof returnTo !== 'string') return null;
    return { state, nonce, verifier, returnTo };
  } catch {
    return null;
  }
}

const REFUSALS: Record<SignInRefusal, { status: number; title: string; text: string }> = {
  not_in_tenant: {
    status: 403,
    title: 'Sign-in refused',
    text: "Only work accounts in the company's Microsoft Entra tenant can use Launch Tracker. Sign in with your work account.",
  },
  guest_not_allowed: {
    status: 403,
    title: 'Sign-in refused',
    text: 'Guest accounts cannot use Launch Tracker. Sign in with your own work account in the company tenant.',
  },
  no_role: {
    status: 403,
    title: 'No access yet',
    text: 'Your account has no Launch Tracker role. Ask a Workspace admin to add you to one of the Launch Tracker groups, then sign in again.',
  },
  state_mismatch: {
    status: 400,
    title: 'Sign-in expired',
    text: 'This sign-in took longer than 10 minutes or was started in another tab. Start it again.',
  },
  account_disabled: {
    status: 403,
    title: 'Account turned off',
    text: 'Your Launch Tracker account has been turned off. Ask a Workspace admin to turn it back on.',
  },
  account_conflict: {
    status: 409,
    title: 'Sign-in refused',
    text: 'Another Launch Tracker account already uses your e-mail address. Ask a Workspace admin to remove the old account, quoting request {request}.',
  },
  entra_error: {
    status: 502,
    title: 'Sign-in failed',
    text: 'Microsoft Entra could not complete the sign-in. Try again; if it keeps failing, report request {request}.',
  },
};

/** A plain page: no scripts or styles, so it works under the app's Content-Security-Policy. */
function refusalPage(title: string, text: string, retry: string | null): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(title)} · Launch Tracker</title></head><body><h1>${escape(title)}</h1><p>${escape(text)}</p>`,
    retry ? `<p><a href="${retry}">Sign in again</a></p>` : '',
    '</body></html>',
  ].join('');
}
