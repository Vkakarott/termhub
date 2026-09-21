// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
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

import { FocusProvider } from '../lib/focus';
import { OfficePage } from './OfficePage';

const tab = (id: string, projectId: string): OfficeTab =>
  ({ id, project_id: projectId, name: id, kind: 'terminal', position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, alive: true, progress: null }) as OfficeTab;
const room = (id: string, tabs: OfficeTab[] = []): OfficeRoom => ({ project: { id, name: id, status: 'active' } as Project, tabs, tasks: null });
const snap = (machineId: string, rooms: OfficeRoom[]): OfficeSnapshot => ({ machine: { id: machineId, name: machineId } as never, reachable: true, rooms });

// lets a test drive real react-router navigation (path AND query string) the same way a production
// click or a pasted URL would, instead of only ever changing props — this is what actually exercises
// the "snapshot/model still belongs to the previous machine for one render" window the bug lived in
let testNavigate: NavigateFunction | undefined;
let testSearch = '';
function NavCapture() {
  testNavigate = useNavigate();
  testSearch = useLocation().search;
  return null;
}

function renderPage(initialEntry = '/office/m1') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <FocusProvider>
        <NavCapture />
        <Routes>
          <Route path="/office/:machineId" element={<OfficePage />} />
        </Routes>
      </FocusProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  FakeOfficeScene.instances = [];
  officeMock.mockReset();
  canMock.mockReset();
  canMock.mockReturnValue(true);
  testNavigate = undefined;
  testSearch = '';
  dataState.current = { machines: [{ id: 'm1', name: 'jarvis' }], projects: [{ id: 'p1', machine_id: 'm1', status: 'active' }], statuses: { m1: 'online' }, loading: true };
  monitorState.current = { items: [], needsYou: [], tabState: () => undefined, connected: true };
});

afterEach(() => {
  cleanup();
});

describe('OfficePage scene lifecycle', () => {
  it('mounts exactly one scene once data has loaded, and hands it a model (pins the round-1 fix)', async () => {
    officeMock.mockResolvedValue(snap('m1', [room('p1', [])]));
    const { rerender } = renderPage();
    // loading: the host <div> does not exist yet — the mount effect must not have anything to grab
    expect(FakeOfficeScene.instances).toHaveLength(0);

    dataState.current = { ...dataState.current, loading: false };
    await act(async () => {
      rerender(
        <MemoryRouter initialEntries={['/office/m1']}>
          <FocusProvider>
            <NavCapture />
            <Routes>
              <Route path="/office/:machineId" element={<OfficePage />} />
            </Routes>
          </FocusProvider>
        </MemoryRouter>,
      );
    });

    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(FakeOfficeScene.instances[0].models.length).toBeGreaterThan(0);
  });

  it('keeps the same scene across a room click and a focus-mode toggle (both only change the query string)', async () => {
    officeMock.mockResolvedValue(snap('m1', [room('p1', []), room('p2', [])]));
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

    // toggling focus mode changes ?focus=1 the same way a room click changes ?room= — assert the
    // query string really moved (a real FocusProvider is in the tree, not the no-op default context)
    // before trusting the "scene didn't move" assertions below
    fireEvent.click(screen.getByText('modo foco'));
    await act(async () => {});
    expect(screen.getByText('sair do foco (Esc)')).toBeTruthy(); // only rendered while focus === true
    expect(screen.queryByText('modo foco')).toBeNull(); // the top bar (and its button) is gone in focus mode
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(scene.destroyed).toBe(false);
  });

  it('auto-drills into the one room with desks without recreating the scene', async () => {
    officeMock.mockResolvedValue(snap('m1', [room('p1', [tab('t1', 'p1')])]));
    dataState.current = { ...dataState.current, loading: false };
    renderPage();
    await act(async () => {});

    expect(await screen.findByText('← voltar ao andar')).toBeTruthy();
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(FakeOfficeScene.instances[0].destroyed).toBe(false);
    expect(FakeOfficeScene.instances[0].models.length).toBeGreaterThan(0);
  });

  it('leaves a room without pushing history, so Back does not walk straight back in', async () => {
    // two rooms with desks: no auto-drill, so the room is entered by a real click (a push)
    officeMock.mockResolvedValue(snap('m1', [room('p1', [tab('t1', 'p1')]), room('p2', [tab('t2', 'p2')])]));
    dataState.current = { ...dataState.current, loading: false };
    renderPage();
    await act(async () => {});

    act(() => FakeOfficeScene.instances[0].handlers.onPickRoom('p1'));
    await act(async () => {});
    expect(testSearch).toBe('?room=p1');

    fireEvent.click(screen.getByText('← voltar ao andar'));
    await act(async () => {});
    expect(testSearch).toBe('');

    // the spec: "the browser's back button leaves the room" — it must not put us back inside it
    await act(async () => testNavigate?.(-1));
    expect(testSearch).toBe('');
  });

  it('never seeds a machine-changed scene with the previous machine\'s model or focus target', async () => {
    let resolveM2: ((s: OfficeSnapshot) => void) | undefined;
    const pendingM2 = new Promise<OfficeSnapshot>((resolve) => {
      resolveM2 = resolve;
    });
    officeMock.mockImplementation((id: string) => (id === 'm1' ? Promise.resolve(snap('m1', [room('p1', [tab('t1', 'p1')])])) : pendingM2));
    dataState.current = { ...dataState.current, machines: [{ id: 'm1', name: 'jarvis' }, { id: 'm2', name: 'hal' }], loading: false };
    renderPage();
    await act(async () => {});

    expect(FakeOfficeScene.instances).toHaveLength(1);
    const m1Scene = FakeOfficeScene.instances[0];
    expect(m1Scene.models.length).toBeGreaterThan(0); // m1's floor is on screen
    expect(m1Scene.focusCalls.some(([roomId]) => roomId === 'p1')).toBe(true); // auto-drilled into p1

    // a direct URL change that keeps the same ?room=p1 — the exact shape of the finding: the new
    // machine's snapshot is still pending, and the query string coincidentally still says "p1"
    act(() => testNavigate?.('/office/m2?room=p1'));
    await act(async () => {});

    expect(FakeOfficeScene.instances).toHaveLength(2); // machineId IS a legitimate reason to recreate
    expect(m1Scene.destroyed).toBe(true);
    const m2Scene = FakeOfficeScene.instances[1];
    expect(m2Scene.models).toHaveLength(0); // never handed m1's model
    expect(m2Scene.focusCalls.every(([roomId]) => roomId !== 'p1')).toBe(true); // never asked to frame m1's room

    await act(async () => {
      resolveM2?.(snap('m2', [room('p2', [])]));
    });
    expect(m2Scene.models.length).toBeGreaterThan(0);
    expect(m2Scene.models.at(-1)).toMatchObject({ rooms: [{ id: 'p2' }] });
  });
});

describe('OfficePage status notices', () => {
  // focus mode is the second monitor left open all day: a dropped WebSocket there used to be a
  // frozen picture that looked live, because the whole top bar (notices included) was not rendered
  it('shows "reconectando…" in focus mode, where the top bar is gone', async () => {
    officeMock.mockResolvedValue(snap('m1', [room('p1', [])]));
    dataState.current = { ...dataState.current, loading: false };
    monitorState.current = { ...monitorState.current, connected: false };
    renderPage('/office/m1?focus=1');
    await act(async () => {});

    expect(screen.getByText('sair do foco (Esc)')).toBeTruthy();
    expect(screen.queryByText('modo foco')).toBeNull();
    expect(screen.getByText('reconectando…')).toBeTruthy();
  });

  it('shows "máquina offline" and the tmux notice in both modes', async () => {
    officeMock.mockResolvedValue({ ...snap('m1', [room('p1', [])]), reachable: false });
    dataState.current = { ...dataState.current, loading: false, statuses: { m1: 'offline' as const } };
    const { unmount } = renderPage();
    await act(async () => {});
    expect(screen.getByText('máquina offline')).toBeTruthy();
    unmount();

    renderPage('/office/m1?focus=1');
    await act(async () => {});
    expect(screen.getByText('máquina offline')).toBeTruthy();
    // an offline machine already explains the silence; the tmux notice is for a machine that answers
    expect(screen.queryByText(/sem resposta do tmux/)).toBeNull();
  });
});
