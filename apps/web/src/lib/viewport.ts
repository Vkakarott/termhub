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
 * Whether an on-screen keyboard can ever appear on this window: only a touch screen has one. iPadOS
 * reports a desktop-class window (and, in Safari, a desktop user agent) but still has touch points;
 * a Mac, with or without a trackpad, has none.
 */
export function hasOnScreenKeyboard(win: Window = window): boolean {
  return (win.navigator?.maxTouchPoints ?? 0) > 0;
}

/**
 * Keeps `--app-height` on `<html>` up to date until the returned function is called. Only the
 * screens that need it install this (ChatLayout, and ChatDock while a project chat is shown — full
 * screen on a narrow window, docked in `Layout`'s row on a wide one such as an iPad), so every other
 * screen — the terminals above all — keeps the sizing it already had.
 *
 * On a window that cannot show an on-screen keyboard this is a no-op: the variable stays unset and
 * the shells fall back to their CSS height (`100%`, `100svh`), which is the window. The visual
 * viewport is only tracked for the keyboard, and on a desktop it has nothing the window does not —
 * so anything it reports there can only size the shell to something other than the window. That is
 * what happened when the docked chat started tracking it on every wide window (TER-313): Chrome on
 * a Mac published about half the window, and the whole app ended halfway down the page (TER-385).
 */
export function trackAppHeight(win: Window = window): () => void {
  if (!hasOnScreenKeyboard(win)) return () => {};
  const viewport = win.visualViewport ?? null;
  const root = win.document.documentElement;

  const apply = () => {
    // `height` is in CSS px of the zoomed view: a pinch shrinks it with no keyboard in sight. Times
    // `scale` it is the layout height the visible area covers — the same number at 1× (keyboard or
    // not), and the whole window, not a reflow into the zoomed area, on a pinched desktop page.
    const height = viewport ? viewport.height * (viewport.scale || 1) : win.innerHeight;
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
