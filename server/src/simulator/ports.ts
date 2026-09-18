/** Hash FNV-1a 32 bits (determinístico, sem dependências). */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export interface WdaPorts {
  wdaPort: number;
  mjpegPort: number;
}

/** Portas do WDA na máquina, derivadas do UDID (sem estado persistido). */
export function wdaPorts(udid: string): WdaPorts {
  const h = fnv1a(udid.toUpperCase()) % 100;
  return { wdaPort: 8100 + h, mjpegPort: 9100 + h };
}

/** Sessão tmux onde o runner do WDA roda na máquina. */
export function runnerSessionName(udid: string): string {
  return `termhub-wda-${udid.slice(0, 8).toLowerCase()}`;
}
