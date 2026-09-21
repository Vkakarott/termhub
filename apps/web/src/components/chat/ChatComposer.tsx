import { useEffect, useRef } from 'react';
import { enterSends } from '../../lib/chat-scroll';

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
}

const MIN_ROWS = 2;
const MAX_ROWS = 8;

/**
 * The message box and its send button. Owns only its own height — the text, the pending flag and
 * any error live in `ChatPage`.
 *
 * Grows with the content up to `MAX_ROWS` and then scrolls: no library and no hidden mirror
 * element, just the textarea's own `scrollHeight` turned into a row count (the "rows" attribute,
 * not an inline pixel height, so a browser's own font metrics still decide the line box). jsdom
 * lays nothing out — `scrollHeight` is always 0 in tests — so the row count floors at `MIN_ROWS`
 * instead of going negative, which is also exactly the row count the textarea started at before
 * this task.
 *
 * Enter sends on a fine pointer (a mouse) and writes a newline on a coarse one (a touch keyboard,
 * where Enter is how every other line got started); Shift+Enter is always a newline, on either.
 */
export function ChatComposer({ value, onChange, onSend, sending }: ChatComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Collapsing the box to measure it also collapses how far it can be scrolled, and the browser
    // clamps `scrollTop` to that while it is collapsed — restoring the rows does not bring the
    // scroll position back. Without this, a message past `MAX_ROWS` jumped to its first line on
    // every keystroke.
    const scrollTop = el.scrollTop;
    // Reset to the floor before measuring, so deleting a line shrinks the box back down too, not
    // just growth.
    el.rows = MIN_ROWS;
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const vPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const contentRows = Math.ceil((el.scrollHeight - vPadding) / lineHeight);
    el.rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, contentRows));
    el.scrollTop = scrollTop;
  }, [value]);

  return (
    // `env(safe-area-inset-bottom)` resolves to 0px in every browser today, because the app-wide
    // viewport meta in `index.html` has no `viewport-fit=cover` — this padding is not protecting
    // anything yet, it is what becomes correct the day that meta changes (a change that touches the
    // terminal pages too, so it is not made here). The soft keyboard is a separate follow-up.
    <div className="mb-4 flex items-end gap-2 pb-[env(safe-area-inset-bottom)]">
      <textarea
        ref={ref}
        className="min-w-0 flex-1 resize-none overflow-y-auto rounded-lg border border-line bg-bg-2 px-3 py-2 text-sm"
        rows={MIN_ROWS}
        value={value}
        placeholder="Pergunte ou peça algo às suas máquinas"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && enterSends()) {
            e.preventDefault();
            onSend();
          }
        }}
      />
      <button type="button" className="btn-primary" onClick={onSend} disabled={sending}>
        Enviar
      </button>
    </div>
  );
}
