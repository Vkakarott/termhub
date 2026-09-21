import type { ChatAction } from '../../lib/types';

/** How a decided action reads once there is nothing left to click. `pending` has its own buttons
 * instead of a label here. */
const ACTION_STATUS_LABEL: Record<Exclude<ChatAction['status'], 'pending'>, string> = {
  approved: 'Autorizado',
  denied: 'Recusado',
  expired: 'Expirou sem resposta',
  executed: 'Executado',
  failed: 'Falhou',
};

export interface ChatActionCardProps {
  action: ChatAction;
  /** This card's decision is in flight (`decidingId` in `ChatPage`): its buttons are disabled. */
  deciding: boolean;
  /** The server's pt-BR note for a decision queued behind a busy run (`queuedNotes` in `ChatPage`). */
  note?: string;
  onDecide: (decision: 'approve' | 'deny') => void;
}

/**
 * One gate card, inline in the thread where the concierge proposed it. Presentational only: the
 * request, the decision call and the queued note all live in `ChatPage`.
 */
export function ChatActionCard({ action, deciding, note, onDecide }: ChatActionCardProps) {
  return (
    <li className="rounded-xl border border-attention/40 bg-bg-2 px-4 py-3 text-sm">
      {/* Plain text only — never HTML: this sentence can carry a command the model read off a real terminal screen. */}
      <p className="whitespace-pre-wrap text-fg">{action.summary}</p>
      {action.status === 'pending' ? (
        <div className="mt-2 flex gap-2">
          <button type="button" className="btn-primary" disabled={deciding} onClick={() => onDecide('approve')}>
            Autorizar
          </button>
          <button type="button" className="btn-danger" disabled={deciding} onClick={() => onDecide('deny')}>
            Recusar
          </button>
        </div>
      ) : (
        <p className="mt-1 text-xs text-fg-dim">{ACTION_STATUS_LABEL[action.status]}</p>
      )}
      {note && <p className="mt-1 text-xs text-fg-dim">{note}</p>}
    </li>
  );
}
