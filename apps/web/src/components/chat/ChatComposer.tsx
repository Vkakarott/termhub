import { useEffect, useRef } from 'react';
import { enterSends } from '../../lib/chat-scroll';
import { useDictation, type Dictation } from '../../lib/use-dictation';

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
}

const MIN_ROWS = 1;
const MAX_ROWS = 8;

/**
 * Appends a transcription to whatever is already in the box.
 *
 * Whisper returns its own leading/trailing spaces, and a person who dictates twice in a row must
 * end up with a sentence they can read — so the clip is trimmed and a single space is inserted,
 * except when the box is empty (no leading space) or already ends in whitespace, where the
 * separator the person typed is kept exactly: a newline they wrote stays a newline. A clip that
 * trims away to nothing (silence, a stray tap) leaves the box untouched.
 */
function appendDictated(current: string, text: string): string {
  const clip = text.trim();
  if (!clip) return current;
  if (!current) return clip;
  return /\s$/.test(current) ? current + clip : `${current} ${clip}`;
}

/** Whole seconds as `m:ss` — 65 reads as `1:05`, the way a stopwatch is read. */
function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** What the single circular button does right now. Exactly one of these, in every state. */
type PrimaryRole = 'dictate' | 'send' | 'stop';

const PRIMARY_LABEL: Record<PrimaryRole, string> = {
  dictate: 'Ditar',
  send: 'Enviar',
  stop: 'Parar',
};

/**
 * The message box and its one action button. Owns its own height and its own dictation — the text,
 * the pending flag and any error live in `ChatPage`.
 *
 * Grows with the content up to `MAX_ROWS` and then scrolls: no library and no hidden mirror
 * element, just the textarea's own `scrollHeight` turned into a row count (the "rows" attribute,
 * not an inline pixel height, so a browser's own font metrics still decide the line box). jsdom
 * lays nothing out — `scrollHeight` is always 0 in tests — so the row count floors at `MIN_ROWS`
 * instead of going negative. That floor is one row: the rounded container is visibly a box on its
 * own now, so the box no longer has to be two lines tall to look like one.
 *
 * Enter sends on a fine pointer (a mouse) and writes a newline on a coarse one (a touch keyboard,
 * where Enter is how every other line got started); Shift+Enter is always a newline, on either.
 */
export function ChatComposer({ value, onChange, onSend, sending }: ChatComposerProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // The hook keeps the latest callback, so this closure always sees the current `value`. A clip that
  // adds nothing (silence, a stray tap) is not reported upwards at all: `ChatPage` has no business
  // re-rendering for text that did not change.
  const dictation = useDictation((text) => {
    const next = appendDictated(value, text);
    if (next !== value) onChange(next);
  });

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

  const hasText = value.trim().length > 0;
  /** The clip is on its way to the server: nothing else can be done with the box's content yet. */
  const busy = dictation.state === 'uploading' || dictation.state === 'transcribing';
  // Recording outranks the text: a box that is listening stops, it never sends mid-sentence. With
  // nothing typed the button dictates — unless dictation is off, where the empty box keeps the
  // ordinary (disabled) send button and nothing explains the missing microphone, because a browser
  // that cannot record is not a fault the person can fix from this screen.
  const role: PrimaryRole = dictation.state === 'recording' ? 'stop' : hasText || dictation.state === 'off' ? 'send' : 'dictate';
  const disabled = role === 'stop' ? false : role === 'send' ? !hasText || sending || busy : busy;

  return (
    // `env(safe-area-inset-bottom)` resolves to 0px in every browser today, because the app-wide
    // viewport meta in `index.html` has no `viewport-fit=cover` — this padding is not protecting
    // anything yet, it is what becomes correct the day that meta changes (a change that touches the
    // terminal pages too, so it is not made here). The soft keyboard is a separate follow-up.
    <div className="mb-4 pb-[env(safe-area-inset-bottom)]">
      {/* One box, two rows: the text on top, the action row beneath it. The box, not the textarea,
          shows the focus — the textarea's own outline would draw inside the rounded border, so it is
          dropped and the border lights up instead; a keyboard user must still see where they are. */}
      <div className="min-w-0 rounded-2xl border border-line bg-bg-2 px-3 py-2 focus-within:border-accent">
        <textarea
          ref={ref}
          className="block w-full resize-none overflow-y-auto border-0 bg-transparent px-0 py-1 text-sm text-fg placeholder:text-fg-dim focus:outline-none"
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
        <div className="mt-1 flex items-center justify-end gap-2">
          {dictation.state === 'recording' && <RecordingStatus dictation={dictation} />}
          {busy && <span className="text-xs text-fg-muted">transcrevendo…</span>}
          <button
            type="button"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={PRIMARY_LABEL[role]}
            title={PRIMARY_LABEL[role]}
            disabled={disabled}
            onClick={role === 'stop' ? dictation.stop : role === 'send' ? onSend : dictation.start}
          >
            {role === 'stop' ? <StopIcon /> : role === 'send' ? <ArrowUpIcon /> : <MicIcon />}
          </button>
        </div>
      </div>
      {dictation.error && <p className="mt-1 px-1 text-xs text-danger">{dictation.error}</p>}
    </div>
  );
}

/**
 * The left side of the action row while the mic is open: it is listening, for this long, and it can
 * be dropped. Only while `recording` — once the clip is uploading, the hook's `cancel()` can no
 * longer stop anything, so a cancel button there would be a promise the product cannot keep.
 */
function RecordingStatus({ dictation }: { dictation: Dictation }) {
  return (
    <>
      <span className="h-2 w-2 animate-pulse rounded-full bg-attention" aria-hidden="true" />
      <span className="font-mono text-xs text-fg">{formatClock(dictation.seconds)}</span>
      <button type="button" className="rounded-md px-2 py-1 text-xs text-fg-muted transition-colors hover:bg-bg-3 hover:text-fg" onClick={dictation.cancel}>
        cancelar
      </button>
    </>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4M8 21h8" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20V4" />
      <path d="M5 11l7-7 7 7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  );
}
