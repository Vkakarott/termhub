// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficeSnapshot } from '../lib/types';

const officeMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: { office: (...a: unknown[]) => officeMock(...a) },
}));

import { useOfficeSnapshots } from './useOfficeSnapshots';

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

describe('useOfficeSnapshots', () => {
  it('reads every machine on mount', async () => {
    officeMock.mockImplementation((id: string) => Promise.resolve(snap(id)));
    const { result } = renderHook(() => useOfficeSnapshots(['a', 'b']));
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(2);
    expect(officeMock).toHaveBeenCalledWith('a', false);
    expect(officeMock).toHaveBeenCalledWith('b', false);
    expect(result.current.byMachine.a.snapshot?.machine.id).toBe('a');
    expect(result.current.byMachine.b.snapshot?.machine.id).toBe('b');
  });

  it('a slow machine does not hold the others', async () => {
    let resolveB: ((s: OfficeSnapshot) => void) | undefined;
    const pendingB = new Promise<OfficeSnapshot>((resolve) => {
      resolveB = resolve;
    });
    officeMock.mockImplementation((id: string) => (id === 'b' ? pendingB : Promise.resolve(snap(id))));

    const { result } = renderHook(() => useOfficeSnapshots(['a', 'b']));
    await act(async () => {});

    expect(result.current.byMachine.a.snapshot).toEqual(snap('a'));
    expect(result.current.byMachine.b).toEqual({ snapshot: null, failed: false });

    // let it settle so the promise doesn't leak into the next test
    await act(async () => {
      resolveB?.(snap('b'));
    });
  });

  it('a failed first read is an error block; a failed re-read is not', async () => {
    vi.useFakeTimers();
    officeMock.mockImplementation((id: string) => (id === 'b' ? Promise.reject(new Error('boom')) : Promise.resolve(snap('a'))));
    const { result } = renderHook(() => useOfficeSnapshots(['a', 'b']));
    await act(async () => {});

    expect(result.current.byMachine.b).toEqual({ snapshot: null, failed: true });
    expect(result.current.byMachine.a.snapshot).toEqual(snap('a'));

    // a succeeded once; now its re-read (the next 60s tick) fails
    officeMock.mockImplementation((id: string) => (id === 'a' ? Promise.reject(new Error('boom again')) : Promise.reject(new Error('still down'))));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current.byMachine.a.snapshot).toEqual(snap('a'));
    expect(result.current.byMachine.a.failed).toBe(false);
  });

  it('a later success clears failed', async () => {
    vi.useFakeTimers();
    officeMock.mockImplementation((id: string) => (id === 'b' ? Promise.reject(new Error('boom')) : Promise.resolve(snap('a'))));
    const { result } = renderHook(() => useOfficeSnapshots(['a', 'b']));
    await act(async () => {});
    expect(result.current.byMachine.b.failed).toBe(true);

    officeMock.mockImplementation((id: string) => Promise.resolve(snap(id)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(result.current.byMachine.b.snapshot).toEqual(snap('b'));
    expect(result.current.byMachine.b.failed).toBe(false);
  });

  it('reload(id) re-reads only that machine, fresh', async () => {
    officeMock.mockImplementation((id: string) => Promise.resolve(snap(id)));
    const { result } = renderHook(() => useOfficeSnapshots(['a', 'b']));
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(2);

    let resolveB: ((s: OfficeSnapshot) => void) | undefined;
    const pendingB = new Promise<OfficeSnapshot>((resolve) => {
      resolveB = resolve;
    });
    officeMock.mockImplementation((id: string) => (id === 'b' ? pendingB : Promise.resolve(snap(id))));

    let started = false;
    act(() => {
      started = result.current.reload('b');
    });
    expect(started).toBe(true);
    expect(officeMock).toHaveBeenCalledTimes(3);
    expect(officeMock).toHaveBeenLastCalledWith('b', true);

    let startedAgain = true;
    act(() => {
      startedAgain = result.current.reload('b');
    });
    expect(startedAgain).toBe(false);
    expect(officeMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      resolveB?.(snap('b'));
    });
  });

  it('the 10 s floor applies to focus, not to reload', async () => {
    vi.useFakeTimers();
    officeMock.mockImplementation((id: string) => Promise.resolve(snap(id)));
    const { result } = renderHook(() => useOfficeSnapshots(['a', 'b']));
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    await act(async () => void window.dispatchEvent(new Event('focus')));
    expect(officeMock).toHaveBeenCalledTimes(2);

    let started = false;
    act(() => {
      started = result.current.reload('a');
    });
    expect(started).toBe(true);
    expect(officeMock).toHaveBeenCalledTimes(3);
    expect(officeMock).toHaveBeenLastCalledWith('a', true);
  });

  it('hidden tab is not polled', async () => {
    vi.useFakeTimers();
    officeMock.mockImplementation((id: string) => Promise.resolve(snap(id)));
    renderHook(() => useOfficeSnapshots(['a', 'b']));
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(2);

    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(officeMock).toHaveBeenCalledTimes(2);

    // coming back, the floor is well past 10s (we were hidden for a whole minute): reads fire now
    await act(async () => setVisibility('visible'));
    expect(officeMock).toHaveBeenCalledTimes(4);
  });

  it('adding a machine reads only the new one', async () => {
    officeMock.mockImplementation((id: string) => Promise.resolve(snap(id)));
    const { result, rerender } = renderHook(({ ids }) => useOfficeSnapshots(ids), { initialProps: { ids: ['a', 'b'] } });
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(2);

    rerender({ ids: ['a', 'b', 'c'] });
    await act(async () => {});

    expect(officeMock).toHaveBeenCalledTimes(3);
    expect(officeMock).toHaveBeenLastCalledWith('c', false);
    expect(result.current.byMachine.c.snapshot).toEqual(snap('c'));
  });

  it('removing a machine drops its late response', async () => {
    let resolveB: ((s: OfficeSnapshot) => void) | undefined;
    const pendingB = new Promise<OfficeSnapshot>((resolve) => {
      resolveB = resolve;
    });
    officeMock.mockImplementation((id: string) => (id === 'b' ? pendingB : Promise.resolve(snap(id))));
    const { result, rerender } = renderHook(({ ids }) => useOfficeSnapshots(ids), { initialProps: { ids: ['a', 'b'] } });
    await act(async () => {});

    rerender({ ids: ['a'] });
    await act(async () => {
      resolveB?.(snap('b'));
    });

    expect(Object.keys(result.current.byMachine)).toEqual(['a']);
    expect(result.current.byMachine).not.toHaveProperty('b');
  });

  it('a new array with the same ids restarts nothing', async () => {
    officeMock.mockImplementation((id: string) => Promise.resolve(snap(id)));
    const { rerender } = renderHook(({ ids }) => useOfficeSnapshots(ids), { initialProps: { ids: ['a', 'b'] } });
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(2);

    rerender({ ids: ['a', 'b'] }); // a fresh array, same ids
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(2);
  });

  it('empty machineIds makes no requests, and picks up ids that arrive later', async () => {
    officeMock.mockImplementation((id: string) => Promise.resolve(snap(id)));
    const { result, rerender } = renderHook(({ ids }) => useOfficeSnapshots(ids), { initialProps: { ids: [] as string[] } });
    await act(async () => {});

    expect(officeMock).not.toHaveBeenCalled();
    expect(result.current.byMachine).toEqual({});

    let started = true;
    act(() => {
      started = result.current.reload('x');
    });
    expect(started).toBe(false);
    expect(officeMock).not.toHaveBeenCalled();

    rerender({ ids: ['a'] });
    await act(async () => {});

    expect(officeMock).toHaveBeenCalledWith('a', false);
    expect(result.current.byMachine.a.snapshot).toEqual(snap('a'));
  });

  // Known subtlety (documented in the hook's docstring): a removed machine's id can linger in
  // `inFlight` until its request settles. If it is re-added before then, the re-add's own read is
  // skipped once, but the machine is never stuck: the original response is accepted (it is still
  // valid data for that id), and the next tick reads it again for real once `inFlight` clears.
  it('a machine removed and re-added before its in-flight request settles is not stuck', async () => {
    vi.useFakeTimers();
    let resolveB: ((s: OfficeSnapshot) => void) | undefined;
    const pendingB = new Promise<OfficeSnapshot>((resolve) => {
      resolveB = resolve;
    });
    officeMock.mockImplementation((id: string) => (id === 'b' ? pendingB : Promise.resolve(snap(id))));
    const { result, rerender } = renderHook(({ ids }) => useOfficeSnapshots(ids), { initialProps: { ids: ['a', 'b'] } });
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(2); // a resolved, b still pending

    rerender({ ids: ['a'] }); // remove b while its request is in flight
    rerender({ ids: ['a', 'b'] }); // re-add b before that request settles
    await act(async () => {});

    // the re-add's own read is skipped once: inFlight for 'b' is still held by the original request
    expect(officeMock).toHaveBeenCalledTimes(2);

    // the original (stale, but still valid) response lands because 'b' is wanted again
    await act(async () => {
      resolveB?.(snap('b'));
    });
    expect(result.current.byMachine.b.snapshot).toEqual(snap('b'));

    // never stuck forever: the next tick reads it again for real, now that inFlight was cleared
    officeMock.mockImplementation((id: string) => Promise.resolve(snap(id)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(officeMock.mock.calls.filter(([id]) => id === 'b').length).toBeGreaterThan(1);
  });
});
