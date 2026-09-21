import { renderMarkdown } from '../../lib/markdown';
import type { ChatMessage } from '../../lib/types';

export interface ChatTurnProps {
  message: ChatMessage;
  /** What has streamed for this row so far, if anything (`live.deltas` in `ChatPage`). */
  streaming?: string;
  /** The tool calls seen for this row while it is being written (`live.actions` in `ChatPage`). */
  tools?: { tool: string }[];
  /** The page decided this empty row is the answer being written right now: say "pensando…". */
  waiting: boolean;
  /** The page decided nothing will ever fill this row: say so instead of waiting for ever. */
  failed: boolean;
}

/**
 * One turn of the conversation. The user's words go in a bubble on the right and are never parsed
 * as Markdown — what they typed is what they see. The concierge's answer is left-aligned prose with
 * no bubble, rendered through `renderMarkdown`, which is the only sanitising path in `apps/web` and
 * the only reason `dangerouslySetInnerHTML` is allowed here.
 *
 * Purely presentational: `waiting` and `failed` are decisions `ChatPage` owns (they were each paid
 * for with a production bug) and must never be re-derived here.
 */
export function ChatTurn({ message, streaming, tools, waiting, failed }: ChatTurnProps) {
  if (message.role === 'user') {
    return (
      <li className="flex justify-end">
        {/* `break-words` so a pasted path or URL wraps instead of widening the column on a phone. */}
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-accent/10 px-4 py-2.5 text-sm leading-relaxed text-fg">{message.text}</div>
      </li>
    );
  }

  const body = message.text || streaming || (waiting ? 'pensando…' : '');
  return (
    <li className="text-fg">
      {/* The one place in the chat that renders HTML, and only ever `renderMarkdown`'s output: this
       * text comes from an agent that reads real terminal screens. */}
      {body && <div className="prose-termhub" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />}
      {(tools ?? []).length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {(tools ?? []).map((a, i) => (
            <span key={i} className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-fg-dim">
              {a.tool}
            </span>
          ))}
        </div>
      )}
      {failed && <p className="mt-1 text-xs text-danger">A resposta não terminou — tente de novo.</p>}
    </li>
  );
}
