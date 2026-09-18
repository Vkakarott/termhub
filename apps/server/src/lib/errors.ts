import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export const notFound = (msg = 'Não encontrado') => new HttpError(404, msg, 'NOT_FOUND');
export const badRequest = (msg = 'Requisição inválida') => new HttpError(400, msg, 'BAD_REQUEST');
export const unauthorized = (msg = 'Não autenticado') => new HttpError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'Sem permissão') => new HttpError(403, msg, 'FORBIDDEN');
export const conflict = (msg = 'Conflito') => new HttpError(409, msg, 'CONFLICT');

/**
 * The single place that turns thrown errors into the API's wire shape:
 * zod failures become 400 VALIDATION with the issues, HttpError keeps its own
 * status and code, anything else is a 500 with the details swallowed.
 */
export function applyErrorHandler(fastify: FastifyInstance) {
  fastify.setErrorHandler((err, request, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Dados inválidos', code: 'VALIDATION', issues: err.issues });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) request.log.error({ err }, 'erro não tratado');
    return reply.code(status).send({ error: status >= 500 ? 'Erro interno' : e.message, code: 'ERROR' });
  });
}
