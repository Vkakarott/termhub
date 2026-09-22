/**
 * Pure helpers for the chat thread's scroll behaviour and the composer's Enter key. No React, no
 * DOM writes: ChatPage decides when to read the thread's geometry, and ChatComposer decides when
 * to ask about the pointer — this module only answers the question, never acts on it.
 */

/**
 * True when the scrollable element's visible bottom edge is within `slack` px of its content's
 * bottom — "the reader is basically at the bottom, so keep following new content". A never-
 * scrolled element (jsdom gives every test `scrollTop: 0, scrollHeight: 0, clientHeight: 0`) reads
 * as at the bottom: nobody has moved it away from where it started.
 */
export function isNearBottom(el: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>, slack = 48): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - slack;
}

/**
 * Whether Enter should send the message instead of writing a newline. False only on a coarse
 * pointer (a touch keyboard, where Enter is how you start a new line); true otherwise, and true
 * whenever `matchMedia` itself is unavailable (jsdom, and possibly some real embedders) — the
 * fallback favours never silently taking Enter away from a desktop that answers the query.
 */
export function enterSends(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return !window.matchMedia('(pointer: coarse)').matches;
}

/**
 * Whether this keystroke means "send". ⌘/Ctrl+Enter always does, on every device and whatever
 * `enterSends()` says: it is the shortcut people bring from every other message box, it is
 * unambiguous next to a newline, and it is the only way to send from a hardware keyboard on a
 * tablet, where plain Enter has to stay a line break. Plain Enter keeps its own rule — send on a
 * fine pointer, newline on a touch keyboard — and Shift+Enter is always a newline.
 */
export function sendsMessage(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey'>): boolean {
  if (event.key !== 'Enter') return false;
  if (event.metaKey || event.ctrlKey) return true;
  return !event.shiftKey && enterSends();
}
