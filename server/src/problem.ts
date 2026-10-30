import type { FastifyReply, FastifyRequest } from 'fastify';

/** Sends an `application/problem+json` error in the API contract's shape (section 1, Errors). */
export function sendProblem(request: FastifyRequest, reply: FastifyReply, status: number, code: string, title: string, detail: string): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: `https://launch-tracker.internal/errors/${code}`, title, status, code, detail, requestId: request.id });
}
