import { ApiError } from './errors';

describe('ApiError.fromBody', () => {
  it('maps the wire shape and the Retry-After header to retryAfter', () => {
    const err = ApiError.fromBody(423, { 'retry-after': '900' }, '{"error":"Aparelho bloqueado","code":"DEVICE_LOCKED"}');
    expect(err.status).toBe(423);
    expect(err.code).toBe('DEVICE_LOCKED');
    expect(err.message).toBe('Aparelho bloqueado');
    expect(err.retryAfter).toBe(900);
    expect(err.attemptsLeft).toBeUndefined();
  });

  it('prefers the body\'s retry_after over the header, and maps attempts_left', () => {
    const err = ApiError.fromBody(423, { 'retry-after': '900' }, '{"error":"Senha errada","code":"PIN_INVALID","retry_after":60,"attempts_left":2}');
    expect(err.retryAfter).toBe(60);
    expect(err.attemptsLeft).toBe(2);
  });

  it('falls back to a generic code and message for an unparsable body', () => {
    const err = ApiError.fromBody(423, {}, 'not json');
    expect(err.status).toBe(423);
    expect(err.code).toBe('HTTP_423');
    expect(err.message).toBe('Erro do servidor (423)');
    expect(err.retryAfter).toBeUndefined();
  });

  it('falls back the same way for a body that parses but does not match the shape', () => {
    const err = ApiError.fromBody(500, {}, '{"oops":true}');
    expect(err.code).toBe('HTTP_500');
    expect(err.message).toBe('Erro do servidor (500)');
  });
});
