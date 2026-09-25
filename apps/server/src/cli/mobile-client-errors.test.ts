import { describe, expect, it } from 'vitest';
import { describeError } from './mobile-client-errors.js';

describe('describeError', () => {
  it('names a PIN lock and when to retry', () => {
    expect(describeError({ status: 423, code: 'DEVICE_LOCKED', retryAfter: '900' })).toBe('Aparelho bloqueado por tentativas de PIN; tente de novo em 900 s');
    expect(describeError({ status: 423, code: 'DEVICE_LOCKED' })).toBe('Aparelho bloqueado por tentativas de PIN');
  });

  it('counts wrong PINs', () => {
    expect(describeError({ status: 401, code: 'PIN_INVALID', failures: 2 })).toBe('PIN incorreto (2 erro(s))');
  });

  it("shows the server's update message on 426", () => {
    expect(describeError({ status: 426, code: 'APP_TOO_OLD', message: 'Atualize o app do termhub para continuar' })).toBe('Atualize o app do termhub para continuar');
  });

  it('names a rate limit, with or without retry-after (nginx sends none)', () => {
    expect(describeError({ status: 429, code: 'RATE_LIMITED', retryAfter: '600' })).toBe('Limite de chamadas; tente de novo em 600 s');
    expect(describeError({ status: 429 })).toBe('Limite de chamadas');
  });

  it('falls back to the status and code', () => {
    expect(describeError({ status: 409, code: 'CHAT_NO_MACHINE' })).toBe('Erro 409 CHAT_NO_MACHINE');
    expect(describeError({ status: 500 })).toBe('Erro 500');
  });
});
