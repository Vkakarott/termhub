// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeRoom, OfficeSnapshot, OfficeTab, Project } from '../lib/types';

// vi.mock factories are hoisted above every other top-level statement in this file, including this
// file's own `import { OfficePage } from './OfficePage'` below — so everything a factory needs to
// reference has to be created through vi.hoisted(), not as a plain top-level const/class.
const { officeMock, canMock, dataState, monitorState, FakeOfficeScene } = vi.hoisted(() => {
  /**
   * Pins the scene-mount effect's stability: no WebGL in jsdom, so `OfficeScene` itself is replaced
   * with a spy-able stand-in that records what the page does to it, instead of trying to draw anything.
   */
  class FakeOfficeScene {
    static instances: FakeOfficeScene[] = [];
    handlers: { onPickDesk: (tabId: string, projectId: string) => void; onPickRoom: (id: string) => void; onPickSign: (id: string) => void; onLeaveRoom: () => void };
    models: unknown[] = [];
    focusCalls: Array<[string | null, boolean | undefined]> = [];
    destroyed = false;
    constructor(handlers: FakeOfficeScene['handlers']) {
      this.handlers = handlers;
      FakeOfficeScene.instances.push(this);
    }
    async mount(): Promise<void> {}
    destroy(): void {
      this.destroyed = true;
    }
    setModel(model: unknown): void {
      this.models.push(model);
    }
    focusRoom(roomId: string | null, snap?: boolean): void {
      this.focusCalls.push([roomId, snap]);
    }
  }
  return {
    officeMock: vi.fn(),
    canMock: vi.fn(() => true),
    // mutable containers: the mocked hooks below read `.current` fresh on every call, so the test
    // body can reassign it (e.g. flipping `loading`) and a rerender picks up the new value
    dataState: { current: { machines: [{ id: 'm1', name: 'jarvis' }], projects: [{ id: 'p1', machine_id: 'm1', status: 'active' }], statuses: { m1: 'online' as const }, loading: true } },
    monitorState: { current: { items: [] as unknown[], needsYou: [] as unknown[], tabState: () => undefined, connected: true } },
    FakeOfficeScene,
  };
});

vi.mock('../office/scene/OfficeScene', () => ({ OfficeScene: FakeOfficeScene }));
vi.mock('../lib/api', () => ({ api: { office: (...a: unknown[]) => officeMock(...a) } }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: canMock }) }));
vi.mock('../lib/data', () => ({ useData: () => dataState.current }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => monitorState.current }));

import { OfficePage } from './OfficePage';

const tab = (id: string, projectId: string): OfficeTab =>
  ({ id, project_id: projectId, name: id, kind: 'terminal', position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, alive: true, progress: null }) as OfficeTab;
const room = (id: string, tabs: OfficeTab[] = []): OfficeRoom => ({ project: { id, name: id, status: 'active' } as Project, tabs, tasks: null });
const snap = (rooms: OfficeRoom[]): OfficeSnapshot => ({ machine: { id: 'm1', name: 'jarvis' } as never, reachable: true, rooms });

function renderPage(initialEntry = '/office/m1') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/office/:machineId" element={<OfficePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  FakeOfficeScene.instances = [];
  officeMock.mockReset();
  canMock.mockReset();
  canMock.mockReturnValue(true);
  dataState.current = { machines: [{ id: 'm1', name: 'jarvis' }], projects: [{ id: 'p1', machine_id: 'm1', status: 'active' }], statuses: { m1: 'online' }, loading: true };
  monitorState.current = { items: [], needsYou: [], tabState: () => undefined, connected: true };
});

afterEach(() => {
  cleanup();
});

describe('OfficePage scene lifecycle', () => {
  it('mounts exactly one scene once data has loaded, and hands it a model (pins the round-1 fix)', async () => {
    officeMock.mockResolvedValue(snap([room('p1', [])]));
    const { rerender } = renderPage();
    // loading: the host <div> does not exist yet — the mount effect must not have anything to grab
    expect(FakeOfficeScene.instances).toHaveLength(0);

    dataState.current = { ...dataState.current, loading: false };
    await act(async () => {
      rerender(
        <MemoryRouter initialEntries={['/office/m1']}>
          <Routes>
            <Route path="/office/:machineId" element={<OfficePage />} />
          </Routes>
        </MemoryRouter>,
      );
    });

    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(FakeOfficeScene.instances[0].models.length).toBeGreaterThan(0);
  });

  it('keeps the same scene across a room click and a focus-mode toggle (both only change the query string)', async () => {
    officeMock.mockResolvedValue(snap([room('p1', []), room('p2', [])]));
    dataState.current = { ...dataState.current, loading: false };
    renderPage();
    await act(async () => {});

    expect(FakeOfficeScene.instances).toHaveLength(1);
    const scene = FakeOfficeScene.instances[0];

    // simulate a click on a room in the (faked) scene, exactly as the real OfficeScene would call back
    act(() => scene.handlers.onPickRoom('p1'));
    expect(await screen.findByText('← voltar ao andar')).toBeTruthy();
    expect(FakeOfficeScene.instances).toHaveLength(1); // no new scene was constructed
    expect(scene.destroyed).toBe(false);
    expect(scene.focusCalls.at(-1)?.[0]).toBe('p1');

    // toggling focus mode changes ?focus=1 the same way a room click changes ?room=
    fireEvent.click(screen.getByText('modo foco'));
    await act(async () => {});
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(scene.destroyed).toBe(false);
  });

  it('auto-drills into the one room with desks without recreating the scene', async () => {
    officeMock.mockResolvedValue(snap([room('p1', [tab('t1', 'p1')])]));
    dataState.current = { ...dataState.current, loading: false };
    renderPage();
    await act(async () => {});

    expect(await screen.findByText('← voltar ao andar')).toBeTruthy();
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(FakeOfficeScene.instances[0].destroyed).toBe(false);
    expect(FakeOfficeScene.instances[0].models.length).toBeGreaterThan(0);
  });
});
