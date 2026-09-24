/**
 * What the command-line phone prints for a failed call. Pure, so it is unit-tested apart from the
 * CLI. It reads only the status, the error code, the server's own message, the PIN failure count
 * and `retry-after` — never a token, a secret, a challenge or a proof.
 */
export interface ApiErrorInfo {
  status: number;
  code?: string;
  /** the server's `error` field (a pt-BR sentence) */
  message?: string;
  failures?: number;
  /** the `retry-after` header, in seconds */
  retryAfter?: string | null;
}

const seconds = (v: string | null | undefined): number | null => {
  if (!v || !/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
};

export function describeError(e: ApiErrorInfo): string {
  const wait = seconds(e.retryAfter);
  if (e.status === 423 || e.code === 'DEVICE_LOCKED') {
    return `Aparelho bloqueado por tentativas de PIN${wait !== null ? `; tente de novo em ${wait} s` : ''}`;
  }
  if (e.status === 401 && e.code === 'PIN_INVALID') {
    return `PIN incorreto${typeof e.failures === 'number' ? ` (${e.failures} erro(s))` : ''}`;
  }
  if (e.status === 426) return e.message ?? 'Atualize o app do termhub para continuar';
  if (e.status === 429) return `Limite de chamadas${wait !== null ? `; tente de novo em ${wait} s` : ''}`;
  return `Erro ${e.status}${e.code ? ` ${e.code}` : ''}`;
}
