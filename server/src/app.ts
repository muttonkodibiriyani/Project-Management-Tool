import fastifyStatic from '@fastify/static';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { HealthReport } from './health.js';

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
  logger?: boolean;
}

export function buildApp({ publicDir, health, logger = false }: AppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: request => request.url === '/healthz' }),
  });

  app.addHook('onSend', async (request, reply) => {
    reply.headers(SECURITY_HEADERS);
    // Vite names every file under /assets/ after its content, so those never change.
    const immutable = reply.statusCode === 200 && request.url.startsWith('/assets/');
    reply.header('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  });

  app.setErrorHandler(async (error: { statusCode?: number; message: string }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status < 500) return reply.code(status).send({ error: error.message });
    request.log.error({ err: error }, 'request failed');
    return reply.code(status).send({ error: `The server could not handle this request. Try again; if it keeps failing, report request ${request.id}.` });
  });

  // Liveness: answers while the process runs, whatever the state of the database and storage.
  app.get('/healthz', () => ({ status: 'ok' }));

  app.get('/api/health', async (_request, reply) => {
    const report = await health();
    return reply.code(report.status === 'ok' ? 200 : 503).send(report);
  });

  void app.register(fastifyStatic, { root: publicDir, cacheControl: false });

  return app;
}
