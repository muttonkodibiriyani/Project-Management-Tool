import { randomUUID } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type pg from 'pg';
import { api } from './api/plugin.js';
import { publicHealth, type HealthReport } from './health.js';
import { installAuth, type AuthOptions } from './auth/plugin.js';

/**
 * gr8r-studio makes no network calls of its own and loads only its own files plus Google Fonts.
 * Two inline mouse handlers in its date picker are allowed by hash (app.test.ts checks them against
 * the built bundle); its style attributes and two <style> elements need 'unsafe-inline' for styles.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'unsafe-hashes' 'sha256-S9SZ406eQJPdiLai6bLIzozLksmwigz1iB3NLTQWWA4=' 'sha256-TPdPjM5o4T3DUEhF5THjjmcc4fs7IACXeV28y97Vgb0='",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

export interface AppOptions {
  publicDir: string;
  health: () => Promise<HealthReport>;
  pool: pg.Pool;
  auth: AuthOptions;
  logger?: FastifyServerOptions['logger'];
  /** Trusted proxy hops for request.ip (Config.proxyHops); 0 ignores X-Forwarded-For. */
  proxyHops?: number;
}

export function buildApp({ publicDir, health, pool, auth, logger = false, proxyHops = 0 }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    trustProxy: (_address: string, hop: number) => hop < proxyHops,
    logController: new LogController({ disableRequestLogging: request => request.url === '/healthz' }),
    genReqId: () => randomUUID(),
    // API bodies are checked as sent: an unknown property is an error, never silently dropped.
    ajv: { customOptions: { removeAdditional: false, allErrors: true } },
  });

  app.addHook('onSend', async (request, reply) => {
    reply.headers(SECURITY_HEADERS);
    reply.header('x-request-id', request.id);
    // Vite names every file under /assets/ after its content, so those never change.
    const immutable = reply.statusCode === 200 && request.url.startsWith('/assets/');
    // API answers can hold margins and contacts: no browser or proxy keeps them.
    const policy = request.url.startsWith('/api/v1') ? 'private, no-store' : immutable ? 'public, max-age=31536000, immutable' : 'no-cache';
    reply.header('cache-control', policy);
  });

  app.setErrorHandler(async (error: { statusCode?: number; message: string }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: error.message });
    request.log.error({ err: error }, 'request failed');
    return reply.code(status).send({ error: `The server could not handle this request. Try again; if it keeps failing, report request ${request.id}.` });
  });

  installAuth(app, auth);

  // Liveness: answers while the process runs, whatever the state of the database and storage.
  app.get('/healthz', () => ({ status: 'ok' }));

  // Readiness: anyone may ask, so the answer names each check and whether it passed. Why one failed,
  // with hosts and users, goes only to the server log.
  app.get('/api/health', async (request, reply) => {
    const report = await health();
    for (const check of report.checks) if (!check.ok) request.log.error({ check: check.name }, check.error ?? `${check.name} failed its check`);
    return reply.code(report.status === 'ok' ? 200 : 503).send(publicHealth(report));
  });

  void app.register(api, { prefix: '/api/v1', pool });
  void app.register(fastifyStatic, { root: publicDir, cacheControl: false });

  return app;
}
