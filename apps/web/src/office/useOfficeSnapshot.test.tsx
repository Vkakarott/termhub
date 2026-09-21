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
  vi.resetAllMocks();
});

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
});
