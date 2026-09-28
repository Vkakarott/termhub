// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_HEIGHT_VAR, trackAppHeight } from './viewport';

/** A window with a scriptable visual viewport: jsdom has no `visualViewport` and never resizes one. */
function fakeWindow(opts: { viewportHeight?: number | null; scale?: number; innerHeight?: number; scrollY?: number; touchPoints?: number } = {}) {
  // a touch screen by default: every keyboard scenario below is a phone or an iPad
  const { viewportHeight = 400, scale = 1, innerHeight = 800, scrollY = 0, touchPoints = 5 } = opts;
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, fn: () => void) => {
    const set = listeners.get(type) ?? new Set();
    set.add(fn);
    listeners.set(type, set);
  };
  const off = (type: string, fn: () => void) => listeners.get(type)?.delete(fn);
  const viewport =
    viewportHeight === null ? undefined : { height: viewportHeight, scale, addEventListener: on, removeEventListener: off };
  const win = {
    visualViewport: viewport,
    innerHeight,
    scrollY,
    scrollTo: vi.fn(),
    navigator: { maxTouchPoints: touchPoints },
    document: window.document,
    addEventListener: on,
    removeEventListener: off,
  } as unknown as Window;
  const fire = (type: string) => listeners.get(type)?.forEach((fn) => fn());
  const listenerCount = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  return { win, viewport, fire, listenerCount };
}

const appHeight = () => document.documentElement.style.getPropertyValue(APP_HEIGHT_VAR);

afterEach(() => {
  document.documentElement.style.removeProperty(APP_HEIGHT_VAR);
});

describe('trackAppHeight', () => {
  it('publishes the visual viewport height, not the layout viewport one', () => {
    const { win } = fakeWindow({ viewportHeight: 412, innerHeight: 844 });
    trackAppHeight(win);
    expect(appHeight()).toBe('412px');
  });

  it('follows the keyboard opening and closing', () => {
    const { win, viewport, fire } = fakeWindow({ viewportHeight: 844 });
    trackAppHeight(win);
    expect(appHeight()).toBe('844px');

    (viewport as { height: number }).height = 390.4; // keyboard up
    fire('resize');
    expect(appHeight()).toBe('390px');

    (viewport as { height: number }).height = 844; // keyboard down
    fire('resize');
    expect(appHeight()).toBe('844px');
  });

  it('ignores pinch zoom: a zoomed-in page keeps its layout height instead of reflowing into the zoomed area', () => {
    // A trackpad pinch on a desktop, where the docked chat installs this too: the visual viewport
    // shows half the page at 2×, yet the layout still has a whole window to fill.
    const { win, viewport, fire } = fakeWindow({ viewportHeight: 900, innerHeight: 900 });
    trackAppHeight(win);
    Object.assign(viewport as object, { height: 450, scale: 2 });
    fire('resize');
    expect(appHeight()).toBe('900px');
  });

  it('pins the page back to the top, undoing the scroll Safari does to reveal the focused field', () => {
    const { win } = fakeWindow({ scrollY: 260 });
    trackAppHeight(win);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it('leaves an unscrolled page alone', () => {
    const { win } = fakeWindow({ scrollY: 0 });
    trackAppHeight(win);
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it('falls back to innerHeight where there is no visual viewport', () => {
    const { win } = fakeWindow({ viewportHeight: null, innerHeight: 768 });
    trackAppHeight(win);
    expect(appHeight()).toBe('768px');
  });

  it('is a no-op on a window without a touch screen (a desktop): no variable, no listeners (TER-385)', () => {
    // A desktop browser has no on-screen keyboard, so its visual viewport never has anything the
    // window does not; whatever it reports (Chrome on a Mac gave about half the window) can only size
    // the shell to something other than the window. The CSS fallback (100% / 100svh) is the window.
    const { win, listenerCount } = fakeWindow({ touchPoints: 0, viewportHeight: 480, innerHeight: 959 });
    const stop = trackAppHeight(win);
    expect(appHeight()).toBe('');
    expect(listenerCount()).toBe(0);
    expect(win.scrollTo).not.toHaveBeenCalled();
    stop();
    expect(appHeight()).toBe('');
  });

  it('still tracks on an iPad: a desktop-class window, but a touch screen with a keyboard', () => {
    const { win } = fakeWindow({ touchPoints: 5, viewportHeight: 417, innerHeight: 834 });
    trackAppHeight(win);
    expect(appHeight()).toBe('417px');
  });

  it('drops its listeners and the variable on cleanup, so other routes keep their own sizing', () => {
    const { win, listenerCount } = fakeWindow();
    const stop = trackAppHeight(win);
    expect(listenerCount()).toBeGreaterThan(0);
    stop();
    expect(listenerCount()).toBe(0);
    expect(appHeight()).toBe('');
  });
});
