import fastifyCookie from '@fastify/cookie';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { allows, isAccess } from '../access/policy.js';
import { loadCaller, loadWorkspace, SESSION_COOKIE } from './context.js';
import { ApiError, type FieldError } from './problem.js';
import { routes } from './routes/index.js';

export interface ApiOptions {
  pool: pg.Pool;
}

const CSRF_VALUE = 'launch-tracker';
const UNAVAILABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', '57P01', '57P03', '53300']);

interface AjvError {
  instancePath: string;
  keyword: string;
  message?: string;
  params: { missingProperty?: string; additionalProperty?: string; format?: string };
}

function fieldErrors(validation: AjvError[]): FieldError[] {
  return validation.map(error => {
    const base = error.instancePath.slice(1).replaceAll('/', '.');
    const join = (name: string) => (base ? `${base}.${name}` : name);
    switch (error.keyword) {
      case 'required':
        return { path: join(error.params.missingProperty ?? ''), code: 'required', message: `${error.params.missingProperty ?? 'A field'} is required.` };
      case 'additionalProperties':
        return {
          path: join(error.params.additionalProperty ?? ''),
          code: 'unknown_field',
          message: `${error.params.additionalProperty ?? 'This field'} is not a field you can send here.`,
        };
      case 'maxLength':
      case 'maxItems':
        return { path: base, code: 'too_long', message: `${base} is too long: ${error.message ?? ''}.` };
      case 'minimum':
      case 'maximum':
      case 'minLength':
      case 'minItems':
      case 'enum':
        return { path: base, code: 'out_of_range', message: `${base} ${error.message ?? 'is out of range'}.` };
      case 'format':
        return error.params.format === 'date'
          ? { path: base, code: 'invalid_date', message: 'Use YYYY-MM-DD.' }
          : { path: base, code: 'invalid_type', message: `${base} must be a ${error.params.format ?? 'valid value'}.` };
      default:
        return { path: base, code: 'invalid_type', message: `${base || 'The body'} ${error.message ?? 'is not valid'}.` };
    }
  });
}

function toProblem(error: FastifyError & { validation?: AjvError[]; validationContext?: string }): ApiError | undefined {
  if (error instanceof ApiError) return error;
  if (error.validation) {
    if (error.validationContext === 'body') {
      const errors = fieldErrors(error.validation);
      return new ApiError(422, 'validation_failed', errors.length === 1 ? (errors[0]?.message ?? '') : `${errors.length} fields are not valid.`, { errors });
    }
    return new ApiError(400, 'bad_request', `The ${error.validationContext ?? 'request'} is not valid: ${error.message}.`);
  }
  if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return new ApiError(413, 'payload_too_large', 'The request body is over 1 MiB. Send fewer items at a time.');
  const pgCode = (error as { code?: string }).code;
  if (pgCode === '23505') {
    return new ApiError(409, 'duplicate', 'This already exists. Use the existing one, or change the key or name.', {
      errors: [{ path: (error as { constraint?: string }).constraint ?? '', code: 'duplicate', message: 'Already in use.' }],
    });
  }
  if (pgCode === '23503')
    return new ApiError(422, 'validation_failed', 'The request refers to something that does not exist.', {
      errors: [{ path: '', code: 'unknown_ref', message: 'Unknown id.' }],
    });
  if (pgCode && UNAVAILABLE.has(pgCode)) return new ApiError(503, 'unavailable', 'The database cannot be reached just now. Try again in a few seconds.');
  if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
    return new ApiError(error.statusCode, 'bad_request', `The request could not be read: ${error.message}.`);
  }
  return undefined;
}

function sendProblem(reply: FastifyReply, request: FastifyRequest, problem: ApiError) {
  if (problem.status === 503) reply.header('retry-after', '5');
  return reply.code(problem.status).type('application/problem+json').send(problem.body(request.id));
}

/**
 * Everything under /api/v1. Fails closed: a route without a valid `config.access` stops the server at startup,
 * every request needs a session, and every non-GET request needs the CSRF header.
 */
export async function api(app: FastifyInstance, { pool }: ApiOptions) {
  await app.register(fastifyCookie);

  app.addHook('onRoute', route => {
    if (!isAccess(route.config?.access)) {
      throw new Error(`${String(route.method)} ${route.url} declares no valid config.access ('any', 'editor' or app roles); every /api/v1 route must.`);
    }
  });

  app.addHook('onRequest', async request => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers['x-requested-with'] !== CSRF_VALUE) {
      throw new ApiError(403, 'csrf_header_missing', `Send the header X-Requested-With: ${CSRF_VALUE} with every change.`);
    }
    request.caller = await loadCaller(pool, request.cookies[SESSION_COOKIE]);
    const access = request.routeOptions.config.access;
    const { ws } = request.params as { ws?: string };
    if (ws !== undefined) request.workspace = await loadWorkspace(pool, ws, request.caller);
    if (!isAccess(access) || !allows(access, request.caller))
      throw new ApiError(403, 'forbidden', 'Your role may not do this. Ask a workspace admin if you need it.');
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    const problem = toProblem(error);
    if (problem) return sendProblem(reply, request, problem);
    request.log.error({ err: error }, 'request failed');
    return sendProblem(
      reply,
      request,
      new ApiError(500, 'internal', `The server could not handle this request. Try again; if it keeps failing, report request ${request.id}.`),
    );
  });

  // gr8r's static files answer every other path, so the API claims the rest of /api/v1 itself: the hooks above run first,
  // and an unknown path is 401 without a session, like every other.
  const unknown = { config: { access: 'any' as const } };
  const answerUnknown = async (request: FastifyRequest, reply: FastifyReply) =>
    sendProblem(reply, request, new ApiError(404, 'not_found', `There is no ${request.method} ${request.url.split('?')[0] ?? ''} in this API.`));
  app.all('/', unknown, answerUnknown);
  app.all('/*', unknown, answerUnknown);

  await app.register(routes, { pool });
}
