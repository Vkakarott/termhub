// The subagents panel (spec 2026-09-26 §4): a line-for-line port of the web's `lib/subagents.ts`
// (design spec §6) — same labels, same elapsed-time wording, same list op, so the two clients read
// identically.
import type { SubagentStatus, SubagentView } from './types';

/** The subagents panel (spec 2026-09-26 §4): pt-BR status line for each row. */
export const SUBAGENT_STATUS_LABEL: Record<SubagentStatus, string> = {
  running: 'rodando',
  stopping: 'cancelando…',
  completed: 'concluído',
  failed: 'falhou',
  stopped: 'cancelado',
  interrupted: 'interrompido',
};

/** Still doing something (or being asked to stop) — the only ones the header button counts. */
export const isActive = (s: SubagentView): boolean => s.status === 'running' || s.status === 'stopping';

const minutesLabel = (ms: number): string => {
  const minutes = Math.floor(ms / 60_000);
  return minutes < 1 ? 'menos de 1 min' : `${minutes} min`;
};

/**
 * How long a row has been at it: "há N min" while it is still running (or being cancelled), "levou N
 * min" once it ended — both "menos de 1 min" under a minute, prefixed the same way ("há menos de 1
 * min" / "levou menos de 1 min").
 */
export function elapsedLabel(s: SubagentView, now: number): string {
  const running = isActive(s);
  const start = new Date(s.started_at).getTime();
  const end = running ? now : s.ended_at !== null ? new Date(s.ended_at).getTime() : now;
  const ms = Math.max(0, end - start);
  return running ? `há ${minutesLabel(ms)}` : `levou ${minutesLabel(ms)}`;
}

/** Replaces a row by id, or prepends a new one — the panel's own newest-first order. */
export function upsertSubagent(list: SubagentView[], s: SubagentView): SubagentView[] {
  const idx = list.findIndex((x) => x.id === s.id);
  if (idx === -1) return [s, ...list];
  const next = list.slice();
  next[idx] = s;
  return next;
}
