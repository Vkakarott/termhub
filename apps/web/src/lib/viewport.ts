/**
 * The height the page can actually show right now, published as a CSS variable.
 *
 * `100svh` and `100dvh` describe the viewport minus the browser's own chrome — never minus the
 * on-screen keyboard. On iOS Safari the layout viewport keeps its full height while the keyboard is
 * up and only the *visual* viewport shrinks, so a shell sized in `svh` stays a whole screen tall
 * behind the keyboard: Safari scrolls that taller page to bring the focused field into view, and
 * the rest of the shell reads as a slab of empty space you can pan around under the message box.
 * That is what /chat looked like on a phone. `--app-height` is `visualViewport.height`, so a shell
 * can size itself to what is visible instead of to what the layout viewport claims.
 */
export const APP_HEIGHT_VAR = '--app-height';

/**
 * Keeps `--app-height` on `<html>` up to date until the returned function is called. Only the
 * routes that need it install this (ChatLayout, next to its `chat-locked` body class), so every
 * other screen — the terminals above all — keeps the sizing it already had.
 */
export function trackAppHeight(win: Window = window): () => void {
  const viewport = win.visualViewport ?? null;
  const root = win.document.documentElement;

  const apply = () => {
    const height = viewport?.height ?? win.innerHeight;
    root.style.setProperty(APP_HEIGHT_VAR, `${Math.round(height)}px`);
    // The shell now ends where the keyboard begins, so there is nothing left for the browser to
    // scroll into view. Without this the page keeps the offset Safari scrolled to and the header
    // stays pushed off the top of the screen.
    if (win.scrollY !== 0) win.scrollTo(0, 0);
  };

  apply();
  viewport?.addEventListener('resize', apply);
  // Safari pans the visual viewport (rather than resizing it) for some keyboard transitions: the
  // height it reports is only right once that pan settles.
  viewport?.addEventListener('scroll', apply);
  win.addEventListener('orientationchange', apply);

  return () => {
    viewport?.removeEventListener('resize', apply);
    viewport?.removeEventListener('scroll', apply);
    win.removeEventListener('orientationchange', apply);
    root.style.removeProperty(APP_HEIGHT_VAR);
  };
}
