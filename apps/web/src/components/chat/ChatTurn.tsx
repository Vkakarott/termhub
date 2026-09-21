import { memo, useMemo } from 'react';
import type { MouseEvent } from 'react';
import { decorateCodeBlocks } from '../../lib/code-blocks';
import { renderMarkdown } from '../../lib/markdown';
import type { ChatMessage } from '../../lib/types';

const COPY_FEEDBACK_MS = 1500;

/**
 * The one delegated handler for every copy button a message's decorated HTML may contain — there is
 * no React node per block, since the blocks come from an HTML string. `event.target` is whatever the
 * click actually landed on inside the button (its label span, most likely), so this walks up to the
 * element `decorateCodeBlocks` marked with `data-copy`.
 */
function handleCopyClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target as HTMLElement;
  const button = target.closest('[data-copy]') as HTMLElement | null;
  if (!button) return;

  const pre = button.closest('figure')?.querySelector('pre');
  // `<code>`'s `textContent` for a fenced block always carries the fence's own trailing newline (see
  // markdown.test.ts) — that is a serialiser artefact, not part of what the user typed, so it is
  // trimmed before anything reaches the clipboard.
  const text = (pre?.textContent ?? '').replace(/\n$/, '');

  const clipboard = navigator.clipboard;
  if (!clipboard) return; // No clipboard API (jsdom, an insecure context): report failure, not success.

  clipboard.writeText(text).then(
    () => flashCopied(button),
    () => {},
  );
}

/** Transient, DOM-only feedback on the button that was clicked — there is no React state to hold it,
 * since the button is not a React node. Reverts on its own after `COPY_FEEDBACK_MS`. */
function flashCopied(button: HTMLElement): void {
  const label = button.querySelector('[data-copy-label]');
  if (!label) return;
  const original = label.textContent;
  label.textContent = 'copiado';
  button.setAttribute('aria-label', 'Código copiado');
  window.setTimeout(() => {
    label.textContent = original;
    button.setAttribute('aria-label', 'Copiar código');
  }, COPY_FEEDBACK_MS);
}

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
 *
 * Memoised, and the parsing memoised inside it: a streamed answer re-renders the whole thread on
 * every delta, and parsing plus sanitising one message costs about 1 ms — a 50-message thread was
 * paying ~51 ms per delta, on the same main thread the answer is being written on.
 */
export const ChatTurn = memo(function ChatTurn({ message, streaming, tools, waiting, failed }: ChatTurnProps) {
  const body = message.role === 'user' ? '' : message.text || streaming || (waiting ? 'pensando…' : '');
  // Keyed on the body alone: the same text always sanitises to the same HTML, so a delta only ever
  // re-parses the row it lands in. `decorateCodeBlocks` runs inside the same memo rather than a
  // second pass elsewhere — it, too, would otherwise re-run on every streamed delta.
  const html = useMemo(() => (body ? decorateCodeBlocks(renderMarkdown(body, { markdownOnly: true })) : ''), [body]);

  if (message.role === 'user') {
    return (
      <li className="flex justify-end">
        {/* `break-words` so a pasted path or URL wraps instead of widening the column on a phone. */}
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-accent/10 px-4 py-2.5 text-sm leading-relaxed text-fg">{message.text}</div>
      </li>
    );
  }

  return (
    <li className="text-fg">
      {/* The one place in the chat that renders HTML, and only ever `renderMarkdown`'s output: this
       * text comes from an agent that reads real terminal screens, so `markdownOnly` keeps this to
       * the elements Markdown itself produces — nothing here can make the browser fetch a URL.
       *
       * The two classes are on this container, not on `.prose-termhub` (the notes editor shares that
       * class), and they fix the same finding from both ends: a `ol` with `overflow-y-auto` computes
       * `overflow-x` to `auto`, so anything wider than the column makes the whole conversation — the
       * reader's own bubbles included — scroll sideways on a phone. `break-words` wraps an unbroken
       * path quoted off a terminal; `overflow-x-auto` contains what cannot wrap, since a six-column
       * GFM table's min-content width does not shrink, and gives that scroll to the answer instead of
       * to the thread. `pre` keeps its own horizontal scroll either way. */}
      {body && (
        <div
          className="prose-termhub overflow-x-auto break-words"
          // The one delegated handler for every copy button this row's HTML may contain (there can be
          // several, one per fence) — a per-block React handler is impossible anyway, since the blocks
          // come from an HTML string, not from JSX.
          onClick={handleCopyClick}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
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
});
