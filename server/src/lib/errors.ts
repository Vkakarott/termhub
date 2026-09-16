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
