// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_HEIGHT_VAR, trackAppHeight } from './viewport';

/** A window with a scriptable visual viewport: jsdom has no `visualViewport` and never resizes one. */
function fakeWindow(opts: { viewportHeight?: number | null; innerHeight?: number; scrollY?: number } = {}) {
  const { viewportHeight = 400, innerHeight = 800, scrollY = 0 } = opts;
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, fn: () => void) => {
    const set = listeners.get(type) ?? new Set();
    set.add(fn);
    listeners.set(type, set);
  };
  const off = (type: string, fn: () => void) => listeners.get(type)?.delete(fn);
  const viewport =
    viewportHeight === null ? undefined : { height: viewportHeight, addEventListener: on, removeEventListener: off };
  const win = {
    visualViewport: viewport,
    innerHeight,
    scrollY,
    scrollTo: vi.fn(),
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

  it('drops its listeners and the variable on cleanup, so other routes keep their own sizing', () => {
    const { win, listenerCount } = fakeWindow();
    const stop = trackAppHeight(win);
    expect(listenerCount()).toBeGreaterThan(0);
    stop();
    expect(listenerCount()).toBe(0);
    expect(appHeight()).toBe('');
  });
});
