import { memo } from 'react';
import type { ChatAction, ChatDecisionWord, ChatGrant, ChatProjectGrant, ChatStandingGrant, ChatStandingKind } from '../../lib/types';
import { STANDING_KIND_LABEL, standingKindLabel } from './grant-list-text';
import { untilLabel } from './grant-time';

/** How a decided action reads once there is nothing left to click. `pending` has its own buttons
 * instead of a label here. */
const ACTION_STATUS_LABEL: Record<Exclude<ChatAction['status'], 'pending'>, string> = {
  approved: 'Autorizado',
  denied: 'Recusado',
  expired: 'Expirou sem resposta',
  executed: 'Executado',
  failed: 'Falhou',
};

/** Mirrors the server's `grantable` (apps/server/src/chat/gate.ts): the server refuses anything else. */
export function isTabGrantable(action: ChatAction): boolean {
  const args = (action.args ?? {}) as Record<string, unknown>;
  return action.tool === 'send_input' && args.answering_permission !== true && Boolean(action.tab_id);
}

/** The tools "Permitir sempre neste projeto" can trust: every write that only ever touches the board. */
const BOARD_GRANT_TOOLS = new Set(['create_task', 'add_subtasks', 'update_task', 'move_task']);
/** Mirrors the server's `BOARD_GRANT_TOOLS`; the server still refuses a card whose project does not resolve. */
export const isBoardGrantable = (action: ChatAction): boolean => BOARD_GRANT_TOOLS.has(action.tool);

/** Mirrors the server's `terminalGrantable` (apps/server/src/chat/gate.ts). */
export function isTerminalGrantable(action: ChatAction): boolean {
  const args = (action.args ?? {}) as Record<string, unknown>;
  return (action.tool === 'send_input' || action.tool === 'send_key') && args.answering_permission !== true && Boolean(action.tab_id);
}

/** Mirrors the server's `standingKindOf` (apps/server/src/chat/gate.ts, and its copy in
 * `packages/mobile-api`): which "Liberar sem prazo" kind this card may offer, or null. The server is the
 * judge and also refuses a card whose project (or tab) does not resolve. */
export function standingKindOf(action: ChatAction): ChatStandingKind | null {
  if (action.tool === 'open_tab' || action.tool === 'start_agent') return action.project_id ? action.tool : null;
  if (action.tool === 'close_tab') return action.tab_id ? 'close_tab' : null;
  if (isBoardGrantable(action)) return 'board';
  if (isTerminalGrantable(action)) return 'terminal';
  return null;
}

/** Tools whose standing grant trusts the project's tabs themselves (open, close, start an agent). */
const TAB_LIFECYCLE_TOOLS = new Set(['open_tab', 'close_tab', 'start_agent']);

/** What a call run under a grant adds to its "Executado" line. */
function grantedLabel(action: ChatAction): string {
  if (isBoardGrantable(action)) return ' · quadro confiado';
  if (TAB_LIFECYCLE_TOOLS.has(action.tool)) return ' · liberado no projeto';
  return ' · aba confiada';
}

export interface ChatActionCardProps {
  action: ChatAction;
  /** This card's decision is in flight (`decidingId` in `ChatPanel`): its buttons are disabled. */
  deciding: boolean;
  /** The server's pt-BR note for a decision queued behind a busy run (`queuedNotes` in `ChatPanel`). */
  note?: string;
  /** The active grant this card created ("Permitir sempre nesta aba"), if it is still in force. */
  grant?: ChatGrant;
  /** The active project grant this card created ("Permitir sempre neste projeto"), if still in force. */
  projectGrant?: ChatProjectGrant;
  /** The standing grant this card created ("Liberar sem prazo"), if it has not been revoked. */
  standingGrant?: ChatStandingGrant;
  revoking?: boolean;
  /** Takes the grant's id, so the panel can pass one stable callback to every card. */
  onRevoke?: (grantId: string) => void;
  /** Takes the action's id, for the same reason. */
  onDecide: (id: string, decision: ChatDecisionWord) => void;
}

/**
 * One gate card, inline in the thread where the concierge proposed it. Presentational only: the
 * request, the decision call and the queued note all live in `ChatPanel`. Memoised, with callbacks
 * that take the id: a streamed delta re-renders the panel, and this card must not follow.
 */
export const ChatActionCard = memo(function ChatActionCard({ action, deciding, note, grant, projectGrant, standingGrant, revoking, onRevoke, onDecide }: ChatActionCardProps) {
  const standingKind = standingKindOf(action);
  return (
    <li className="chat-enter rounded-xl border border-attention/40 bg-bg-2 px-4 py-3 text-sm">
      {/* Plain text only — never HTML: this sentence can carry a command the model read off a real terminal screen. */}
      <p className="whitespace-pre-wrap text-fg">{action.summary}</p>
      {/* The subagent whose turn proposed this action (spec 2026-09-26 §4), when there is one. */}
      {action.subagent && <p className="text-xs text-fg-dim">Pedido pelo subagente «{action.subagent.description}»</p>}
      {action.status === 'pending' ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={deciding} onClick={() => onDecide(action.id, 'approve')}>
            Autorizar
          </button>
          {isTabGrantable(action) && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_tab')}>
              Permitir sempre nesta aba
            </button>
          )}
          {isBoardGrantable(action) && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_project')}>
              Permitir sempre neste projeto
            </button>
          )}
          {isTerminalGrantable(action) && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_tab_terminal')}>
              Liberar teclas e shell nesta aba
            </button>
          )}
          {(isTerminalGrantable(action) || isBoardGrantable(action)) && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_project_all')}>
              Liberar tudo neste projeto
            </button>
          )}
          {standingKind && (
            <button type="button" className="btn-ghost" disabled={deciding} onClick={() => onDecide(action.id, 'approve_project_always')}>
              Liberar sem prazo: {STANDING_KIND_LABEL[standingKind]} neste projeto
            </button>
          )}
          <button type="button" className="btn-danger" disabled={deciding} onClick={() => onDecide(action.id, 'deny')}>
            Recusar
          </button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-fg-dim">
          {ACTION_STATUS_LABEL[action.status]}
          {action.grant_id ? grantedLabel(action) : ''}
        </p>
      )}
      {grant && (
        <p className="mt-1 flex items-center gap-2 text-xs text-fg-dim">
          <span>
            {grant.tool === 'terminal' ? 'Teclas e shell liberados nesta aba' : 'Permitido nesta aba'} {untilLabel(grant.expires_at)}
          </span>
          <button type="button" className="underline hover:text-fg" disabled={revoking} onClick={() => onRevoke?.(grant.id)}>
            Revogar
          </button>
        </p>
      )}
      {projectGrant && (
        <p className="mt-1 flex items-center gap-2 text-xs text-fg-dim">
          <span>
            {projectGrant.scope === 'all' ? 'Tudo liberado neste projeto' : 'Permitido neste projeto'} {untilLabel(projectGrant.expires_at)}
          </span>
          <button type="button" className="underline hover:text-fg" disabled={revoking} onClick={() => onRevoke?.(projectGrant.id)}>
            Revogar
          </button>
        </p>
      )}
      {standingGrant && (
        <p className="mt-1 flex items-center gap-2 text-xs text-fg-dim">
          <span>{standingKindLabel(standingGrant.kind)} liberado neste projeto, sem prazo</span>
          <button type="button" className="underline hover:text-fg" disabled={revoking} onClick={() => onRevoke?.(standingGrant.id)}>
            Revogar
          </button>
        </p>
      )}
      {note && <p className="mt-1 text-xs text-fg-dim">{note}</p>}
    </li>
  );
});
