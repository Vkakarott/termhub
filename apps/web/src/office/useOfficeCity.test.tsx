// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficeCity } from '../lib/types';

const officeMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: { office: (...a: unknown[]) => officeMock(...a) },
}));

import { useOfficeCity } from './useOfficeCity';

const cityOf = (name: string): OfficeCity => ({ projects: [{ project: { id: name, name } as never, public_id: `${name}-pub`, tabs: [], tasks: null }], machines: [] });

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  setVisibility('visible');
});

describe('useOfficeCity', () => {
  it('reads the whole city once on mount, not fresh', async () => {
    officeMock.mockResolvedValue(cityOf('a'));
    const { result } = renderHook(() => useOfficeCity(true));
    expect(result.current.city).toBeNull();
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);
    expect(officeMock).toHaveBeenCalledWith(false);
    expect(result.current).toMatchObject({ city: cityOf('a'), failed: false });
  });

  it('reads nothing while disabled, and starts once enabled', async () => {
    officeMock.mockResolvedValue(cityOf('a'));
    const { rerender } = renderHook(({ on }) => useOfficeCity(on), { initialProps: { on: false } });
    await act(async () => {});
    expect(officeMock).not.toHaveBeenCalled();
    rerender({ on: true });
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);
  });

  it('is failed when the first read fails, and keeps the last city when a later one does', async () => {
    vi.useFakeTimers();
    officeMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useOfficeCity(true));
    await act(async () => {});
    expect(result.current).toMatchObject({ city: null, failed: true });
    officeMock.mockResolvedValueOnce(cityOf('a'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toMatchObject({ city: cityOf('a'), failed: false });
    officeMock.mockRejectedValueOnce(new Error('again'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toMatchObject({ city: cityOf('a'), failed: false });
  });

  // review fix: a failed re-read keeps the last city, but the page must be able to say it is old
  it('marks the city stale when a re-read fails, and fresh again on the next good read', async () => {
    vi.useFakeTimers();
    officeMock.mockResolvedValueOnce(cityOf('a'));
    const { result } = renderHook(() => useOfficeCity(true));
    await act(async () => {});
    expect(result.current.stale).toBe(false);
    officeMock.mockRejectedValueOnce(new Error('again'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toMatchObject({ city: cityOf('a'), failed: false, stale: true });
    officeMock.mockResolvedValueOnce(cityOf('b'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toMatchObject({ city: cityOf('b'), stale: false });
  });

  it('is not stale when only the first read failed: that is `failed`', async () => {
    officeMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useOfficeCity(true));
    await act(async () => {});
    expect(result.current).toMatchObject({ city: null, failed: true, stale: false });
  });

  it('re-reads every minute while visible, never while hidden, and at once on coming back', async () => {
    vi.useFakeTimers();
    officeMock.mockResolvedValue(cityOf('a'));
    renderHook(() => useOfficeCity(true));
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(officeMock).toHaveBeenCalledTimes(2);
    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(officeMock).toHaveBeenCalledTimes(2);
    await act(async () => setVisibility('visible'));
    expect(officeMock).toHaveBeenCalledTimes(3);
  });

  it('reads on window focus at most once every 10 s, while reload() asks for a fresh read regardless', async () => {
    vi.useFakeTimers();
    officeMock.mockResolvedValue(cityOf('a'));
    const { result } = renderHook(() => useOfficeCity(true));
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => void window.dispatchEvent(new Event('focus')));
    expect(officeMock).toHaveBeenCalledTimes(1);
    let started = false;
    act(() => {
      started = result.current.reload();
    });
    expect(started).toBe(true);
    expect(officeMock).toHaveBeenLastCalledWith(true);
    await act(async () => {});
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => void window.dispatchEvent(new Event('focus')));
    expect(officeMock).toHaveBeenCalledTimes(3);
    expect(officeMock).toHaveBeenLastCalledWith(false);
  });

  it('never stacks a read on one in flight: reload() says whether it started one', async () => {
    let resolve!: (c: OfficeCity) => void;
    officeMock.mockReturnValueOnce(new Promise<OfficeCity>((r) => (resolve = r)));
    const { result } = renderHook(() => useOfficeCity(true));
    let started = true;
    act(() => {
      started = result.current.reload();
    });
    expect(started).toBe(false);
    expect(officeMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(cityOf('a')));
    officeMock.mockResolvedValue(cityOf('b'));
    act(() => {
      started = result.current.reload();
    });
    expect(started).toBe(true);
    await act(async () => {});
    expect(result.current.city).toEqual(cityOf('b'));
  });

  it('drops an answer that lands after the page is gone', async () => {
    let resolve!: (c: OfficeCity) => void;
    officeMock.mockReturnValueOnce(new Promise<OfficeCity>((r) => (resolve = r)));
    const { result, unmount } = renderHook(() => useOfficeCity(true));
    unmount();
    await act(async () => resolve(cityOf('a')));
    expect(result.current.city).toBeNull();
  });
});
