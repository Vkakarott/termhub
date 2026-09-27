// Same wording as the web's lib/progress.ts (spec 2026-09-26 progress-panel §4.6): keep both in sync.
import type { TAgentOnCard, TProgressEstimate } from '@/services/api/contract';

const HOUR = 3600;

/** "20 min", "1 h", "2,5 h". */
export function formatDuration(seconds: number): string {
  if (seconds < HOUR) return `${Math.round(seconds / 60)} min`;
  const hours = Math.round((seconds / HOUR) * 10) / 10;
  return `${String(hours).replace('.', ',')} h`;
}

/** The card's or epic's estimate as one line (spec D4, D6: work time, never a clock time). */
export function formatEstimate(e: TProgressEstimate): string {
  if (e.kind === 'done') return 'concluído';
  if (e.kind === 'none') return e.reason === 'not_started' ? 'ainda não começou' : 'estimativa após 2 subtarefas';
  const low = formatDuration(e.low_s);
  const high = formatDuration(e.high_s);
  if (low === high) return `~${low} de trabalho`;
  const sameUnit = e.low_s < HOUR === e.high_s < HOUR;
  return `~${sameUnit ? low.replace(/ (min|h)$/, '') : low}–${high} de trabalho`;
}

const STATE_LABEL: Record<NonNullable<TAgentOnCard['state']>, string> = {
  working: 'trabalhando',
  waiting_input: 'esperando você',
  waiting_permission: 'pedindo permissão',
  idle: 'parado',
  error: 'erro',
};

export function stateLabel(state: TAgentOnCard['state']): string {
  return state ? STATE_LABEL[state] : 'sem sinal';
}
