/**
 * Resuming a live concierge run after a restart or a deploy (spec 2026-09-26 panel §3): the clocks
 * every instance shares, and the server note a resumed process reads first.
 */

/** How often an instance proves its live runs are alive (`chat_live_runs.heartbeat_at`). */
export const HEARTBEAT_MS = 30_000;
/** A row whose heartbeat is older than this belongs to an instance that is gone (a crash). */
export const STALE_MS = 90_000;
/** How long a row waits for its host to come back before its open turns close with `HOST_GONE`. */
export const RESUME_WINDOW_MS = 15 * 60 * 1000;
/** How often every instance looks for rows to resume (also once shortly after boot). */
export const SWEEP_MS = 30_000;

/**
 * The first line of a resumed process (pt-BR, like a decision's injection): the server restarted, the
 * subagents it lost — by the description the concierge itself gave them — and how many of the
 * person's messages follow. Descriptions are the concierge's own words, never logged.
 */
export function resumeNote(interrupted: string[], pendingTurns: number): string {
  const subs = interrupted.length
    ? ` Estes subagentes estavam rodando e foram interrompidos: ${interrupted.map((d) => `«${d}»`).join(', ')}. Relance em segundo plano só os que ainda fizerem sentido.`
    : '';
  const turns = pendingTurns > 0 ? ` ${pendingTurns === 1 ? 'A mensagem' : `As ${pendingTurns} mensagens`} a seguir ficaram sem resposta e chegam de novo.` : '';
  return `[termhub] O servidor do termhub reiniciou e o processo desta conversa foi encerrado no meio do trabalho.${subs}${turns}`;
}
