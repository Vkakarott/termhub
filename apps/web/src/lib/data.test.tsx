// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project } from './types';

const api = vi.hoisted(() => ({
  machines: { list: vi.fn(), status: vi.fn() },
  projects: { list: vi.fn() },
}));
vi.mock('./api', () => ({ api }));

import { DataProvider, useData } from './data';

const machine = (id: string) => ({ id, name: id, type: 'agent', is_local: false }) as Machine;
const project = (id: string) => ({ id, name: id, machines: [] }) as unknown as Project;
const forbidden = () => Promise.reject(new Error('403'));

type Data = ReturnType<typeof useData>;
function mount() {
  let d!: Data;
  function Probe() {
    d = useData();
    return null;
  }
  render(
    <DataProvider>
      <Probe />
    </DataProvider>,
  );
  return () => d;
}

beforeEach(() => {
  localStorage.clear();
  api.machines.list.mockReset().mockResolvedValue({ machines: [machine('m1')], latest_agent_version: null });
  api.projects.list.mockReset().mockResolvedValue({ projects: [project('p1')] });
  api.machines.status.mockReset().mockResolvedValue({ online: false });
});
afterEach(cleanup);

describe('DataProvider refresh', () => {
  it('reads both lists and reports no error', async () => {
    const d = mount();
    await waitFor(() => expect(d().loading).toBe(false));
    expect(d().machines.map((m) => m.id)).toEqual(['m1']);
    expect(d().projects.map((p) => p.id)).toEqual(['p1']);
    expect(d().machinesError).toBe(false);
    expect(d().projectsError).toBe(false);
  });

  it('stops loading when one list is refused, keeping the other and flagging the failure', async () => {
    api.machines.list.mockImplementation(forbidden);
    const d = mount();
    await waitFor(() => expect(d().loading).toBe(false));
    expect(d().machinesError).toBe(true);
    expect(d().machines).toEqual([]);
    expect(d().projectsError).toBe(false);
    expect(d().projects.map((p) => p.id)).toEqual(['p1']);
  });

  it('keeps the previous list when a later read fails, and clears the flag on the next success', async () => {
    const d = mount();
    await waitFor(() => expect(d().loading).toBe(false));
    api.projects.list.mockImplementation(forbidden);
    await act(() => d().refresh());
    expect(d().projectsError).toBe(true);
    expect(d().projects.map((p) => p.id)).toEqual(['p1']);

    api.projects.list.mockResolvedValue({ projects: [project('p2')] });
    await act(() => d().refresh());
    expect(d().projectsError).toBe(false);
    expect(d().projects.map((p) => p.id)).toEqual(['p2']);
  });

  it('never rejects, so callers awaiting it (the machine form) keep going', async () => {
    const d = mount();
    await waitFor(() => expect(d().loading).toBe(false));
    api.machines.list.mockImplementation(forbidden);
    api.projects.list.mockImplementation(forbidden);
    await expect(d().refresh()).resolves.toBeUndefined();
  });
});
