// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficeSnapshot } from '../lib/types';

const officeMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: { office: (...a: unknown[]) => officeMock(...a) },
}));

import { useOfficeSnapshot } from './useOfficeSnapshot';

const snap = (machineId: string): OfficeSnapshot => ({ machine: { id: machineId, name: machineId } as never, reachable: true, rooms: [] });

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  setVisibility('visible');
});

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useOfficeSnapshot', () => {
  it('reads on mount and exposes the snapshot', async () => {
    officeMock.mockResolvedValue(snap('m1'));
    const { result } = renderHook(() => useOfficeSnapshot('m1'));
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledWith('m1');
    expect(result.current.snapshot).toEqual(snap('m1'));
    expect(result.current.error).toBeNull();
  });

  it('requests the new machine immediately when it changes mid-request, and ignores the stale response', async () => {
    let resolveA: ((s: OfficeSnapshot) => void) | undefined;
    const pendingA = new Promise<OfficeSnapshot>((resolve) => {
      resolveA = resolve;
    });
    officeMock.mockImplementation((id: string) => (id === 'A' ? pendingA : Promise.resolve(snap('B'))));

    const { result, rerender } = renderHook(({ machineId }) => useOfficeSnapshot(machineId), { initialProps: { machineId: 'A' } });
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledWith('A');
    expect(result.current.snapshot).toBeNull();

    // machine changed while A's request is still in flight: B must be requested right away, not
    // blocked by the stale inFlight guard, and not wait for the next 60s tick or a window focus
    rerender({ machineId: 'B' });
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledWith('B');
    expect(result.current.snapshot).toEqual(snap('B'));

    // A's late response must never overwrite B's snapshot
    await act(async () => {
      resolveA?.(snap('A'));
    });
    expect(result.current.snapshot).toEqual(snap('B'));
  });

  it('a failed re-read keeps the last snapshot with no error; a failed first read reports the pt-BR error', async () => {
    officeMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = renderHook(() => useOfficeSnapshot('m1'));
    await act(async () => {});
    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toBe('Não foi possível carregar o escritório desta máquina.');

    officeMock.mockResolvedValueOnce(snap('m1'));
    await act(async () => {
      result.current.reload();
    });
    expect(result.current.snapshot).toEqual(snap('m1'));
    expect(result.current.error).toBeNull();

    officeMock.mockRejectedValueOnce(new Error('boom again'));
    await act(async () => {
      result.current.reload();
    });
    expect(result.current.snapshot).toEqual(snap('m1'));
    expect(result.current.error).toBeNull();
  });

  it('stops polling while the browser tab is hidden and re-reads when it comes back', async () => {
    vi.useFakeTimers();
    officeMock.mockResolvedValue(snap('m1'));
    renderHook(() => useOfficeSnapshot('m1'));
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);

    // a dashboard left open on another desktop must not ask for a floor nobody is looking at
    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(officeMock).toHaveBeenCalledTimes(1);

    // coming back, the floor on screen is up to three minutes old: read it now, don't wait for the tick
    await act(async () => setVisibility('visible'));
    expect(officeMock).toHaveBeenCalledTimes(2);
  });

  it('keeps focus and visibility from re-reading more often than every 10 s, but never throttles reload()', async () => {
    vi.useFakeTimers();
    officeMock.mockResolvedValue(snap('m1'));
    const { result } = renderHook(() => useOfficeSnapshot('m1'));
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);

    // alt-tabbing in and out is cheap for the person and a GET per switch for the server
    await act(async () => void window.dispatchEvent(new Event('focus')));
    act(() => setVisibility('hidden'));
    await act(async () => setVisibility('visible'));
    expect(officeMock).toHaveBeenCalledTimes(1);

    // the page's own reload() (a monitor push named a tab the snapshot lacks) is exempt
    await act(async () => void result.current.reload());
    expect(officeMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await act(async () => void window.dispatchEvent(new Event('focus')));
    expect(officeMock).toHaveBeenCalledTimes(3);
  });

  it('reload reports whether it actually started a request', async () => {
    let resolvePending: ((s: OfficeSnapshot) => void) | undefined;
    const pending = new Promise<OfficeSnapshot>((resolve) => {
      resolvePending = resolve;
    });
    officeMock.mockImplementationOnce(() => pending).mockResolvedValue(snap('m1'));
    const { result } = renderHook(() => useOfficeSnapshot('m1'));
    await act(async () => {});

    // the mount effect's own reload() is still in flight (the pending promise hasn't resolved)
    let started = true;
    act(() => {
      started = result.current.reload();
    });
    expect(started).toBe(false);

    await act(async () => {
      resolvePending?.(snap('m1'));
    });
    act(() => {
      started = result.current.reload();
    });
    expect(started).toBe(true);
  });
});
