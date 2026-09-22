// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, OfficeRoom, OfficeSnapshot, OfficeTab, Project, User } from '../lib/types';

// vi.mock factories are hoisted above every other top-level statement in this file, including this
// file's own `import { OfficePage } from './OfficePage'` below — so everything a factory needs to
// reference has to be created through vi.hoisted(), not as a plain top-level const/class.
const { officeMock, canMock, dataState, monitorState, authState, FakeOfficeScene } = vi.hoisted(() => {
  /**
   * Pins the scene-mount effect's stability: no WebGL in jsdom, so `OfficeScene` itself is replaced
   * with a spy-able stand-in that records what the page does to it, instead of trying to draw anything.
   */
  type Target = { kind: 'city' } | { kind: 'machine'; machineId: string } | { kind: 'room'; machineId: string; roomId: string };
  class FakeOfficeScene {
    static instances: FakeOfficeScene[] = [];
    handlers: { onPickDesk: (tabId: string, projectId: string) => void; onPickRoom: (machineId: string, roomId: string) => void; onPickMachine: (machineId: string) => void; onPickSign: (id: string) => void; onGoUp: () => void };
    models: Array<{ machines: Array<{ id: string; floor: { rooms: Array<{ id: string }> } }> }> = [];
    focusCalls: Array<[Target, boolean | undefined]> = [];
    destroyed = false;
    constructor(handlers: FakeOfficeScene['handlers']) {
      this.handlers = handlers;
      FakeOfficeScene.instances.push(this);
    }
    /** every target the page asked for, in order */
    get targets(): Target[] {
      return this.focusCalls.map(([t]) => t);
    }
    /** which machines the last model the page handed over carries */
    get machineIds(): string[] {
      return (this.models.at(-1)?.machines ?? []).map((m) => m.id);
    }
    async mount(): Promise<void> {}
    destroy(): void {
      this.destroyed = true;
    }
    setModel(model: FakeOfficeScene['models'][number]): void {
      this.models.push(model);
    }
    focus(target: Target, snap?: boolean): void {
      this.focusCalls.push([target, snap]);
    }
  }
  return {
    officeMock: vi.fn(),
    canMock: vi.fn(() => true),
    // mutable containers: the mocked hooks below read `.current` fresh on every call, so the test
    // body can reassign it (e.g. flipping `loading`) and a rerender picks up the new value
    dataState: { current: { machines: [{ id: 'm1', name: 'jarvis' }], projects: [{ id: 'p1', machine_id: 'm1', status: 'active' }], statuses: { m1: 'online' as const }, loading: true } },
    monitorState: { current: { items: [] as unknown[], needsYou: [] as unknown[], tabState: () => undefined, connected: true } },
    // null by default: every pre-existing test above never claimed a nickname, and the share button
    // must stay out of their way (it renders as a quiet "nothing published" span, never a link)
    authState: { current: { user: null as User | null } },
    FakeOfficeScene,
  };
});

vi.mock('../office/scene/OfficeScene', () => ({ OfficeScene: FakeOfficeScene }));
vi.mock('../lib/api', () => ({ api: { office: (...a: unknown[]) => officeMock(...a) } }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: canMock, user: authState.current.user }) }));
vi.mock('../lib/data', () => ({ useData: () => dataState.current }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => monitorState.current }));

import { FocusProvider } from '../lib/focus';
import { OfficePage } from './OfficePage';

const tab = (id: string, projectId: string): OfficeTab =>
  ({ id, project_id: projectId, name: id, kind: 'terminal', position: 0, state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, activity: null, alive: true, progress: null }) as OfficeTab;
const room = (id: string, tabs: OfficeTab[] = []): OfficeRoom => ({ project: { id, name: id, status: 'active' } as Project, tabs, tasks: null });
const snap = (machineId: string, rooms: OfficeRoom[]): OfficeSnapshot => ({ machine: { id: machineId, name: machineId } as never, reachable: true, rooms });

/** m1 "jarvis" with two rooms that have desks (no auto-drill), m2 "hal" with one. */
function twoMachines() {
  dataState.current = {
    machines: [
      { id: 'm1', name: 'jarvis' },
      { id: 'm2', name: 'hal' },
    ],
    projects: [
      { id: 'p1', machine_id: 'm1', status: 'active' },
      { id: 'p1b', machine_id: 'm1', status: 'active' },
      { id: 'p2', machine_id: 'm2', status: 'active' },
    ],
    statuses: { m1: 'online', m2: 'online' },
    loading: false,
  };
  officeMock.mockImplementation((id: string) =>
    Promise.resolve(id === 'm1' ? snap('m1', [room('p1', [tab('t1', 'p1')]), room('p1b', [tab('t1b', 'p1b')])]) : snap('m2', [room('p2', [tab('t2', 'p2')])])),
  );
}

// lets a test drive real react-router navigation (path AND query string) the same way a production
// click or a pasted URL would, instead of only ever changing props — the rests of the office are
// URLs, so every move the page makes has to be read back from the location
let testNavigate: NavigateFunction | undefined;
let testPath = '';
let testSearch = '';
function NavCapture() {
  testNavigate = useNavigate();
  const location = useLocation();
  testPath = location.pathname;
  testSearch = location.search;
  return null;
}

const tree = (initialEntry: string) => (
  <MemoryRouter initialEntries={[initialEntry]}>
    <FocusProvider>
      <NavCapture />
      <Routes>
        <Route path="/office" element={<OfficePage />} />
        <Route path="/office/:machineId" element={<OfficePage />} />
      </Routes>
    </FocusProvider>
  </MemoryRouter>
);

function renderPage(initialEntry = '/office') {
  return render(tree(initialEntry));
}

const scene = () => FakeOfficeScene.instances[0];
const escape = () => fireEvent.keyDown(document.body, { key: 'Escape' });

beforeEach(() => {
  FakeOfficeScene.instances = [];
  officeMock.mockReset();
  canMock.mockReset();
  canMock.mockReturnValue(true);
  testNavigate = undefined;
  testPath = '';
  testSearch = '';
  dataState.current = { machines: [{ id: 'm1', name: 'jarvis' }], projects: [{ id: 'p1', machine_id: 'm1', status: 'active' }], statuses: { m1: 'online' }, loading: true };
  monitorState.current = { items: [], needsYou: [], tabState: () => undefined, connected: true };
  authState.current = { user: null };
});

afterEach(() => {
  cleanup();
});

describe('OfficePage scene lifecycle', () => {
  it('builds one scene for the visit and hands it the whole city', async () => {
    twoMachines();
    dataState.current = { ...dataState.current, loading: true };
    const { rerender } = renderPage();
    // loading: the host <div> does not exist yet — the mount effect must not have anything to grab
    expect(FakeOfficeScene.instances).toHaveLength(0);

    dataState.current = { ...dataState.current, loading: false };
    await act(async () => {
      rerender(tree('/office'));
    });

    expect(FakeOfficeScene.instances).toHaveLength(1);
    // one scene for the whole account, not one floor at a time
    expect(scene().machineIds.slice().sort()).toEqual(['m1', 'm2']);
  });

  it('keeps the same scene from the city into a machine, a room and back up', async () => {
    twoMachines();
    renderPage('/office?focus=1');
    await act(async () => {});
    expect(FakeOfficeScene.instances).toHaveLength(1);
    const only = scene();

    act(() => only.handlers.onPickMachine('m1'));
    await act(async () => {});
    expect(testPath).toBe('/office/m1');

    act(() => only.handlers.onPickRoom('m1', 'p1'));
    await act(async () => {});
    expect(testSearch).toContain('room=p1');

    escape();
    await act(async () => {});
    expect(testSearch).not.toContain('room=');

    escape();
    await act(async () => {});
    expect(testPath).toBe('/office');

    // every rest of the walk is a camera move on ONE scene: the canvas never blanks
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(only.destroyed).toBe(false);
    expect(only.targets.slice(-3)).toEqual([
      { kind: 'room', machineId: 'm1', roomId: 'p1' },
      { kind: 'machine', machineId: 'm1' },
      { kind: 'city' },
    ]);
  });

  it('keeps the same scene when focus mode is toggled by the real button, not just the fake scene', async () => {
    officeMock.mockResolvedValue(snap('m1', [room('p1', [tab('t1', 'p1')]), room('p1b', [tab('t1b', 'p1b')])]));
    dataState.current = { ...dataState.current, projects: [...dataState.current.projects, { id: 'p1b', machine_id: 'm1', status: 'active' }], loading: false };
    renderPage('/office/m1');
    await act(async () => {});
    expect(FakeOfficeScene.instances).toHaveLength(1);
    const only = scene();

    fireEvent.click(screen.getByText('modo foco'));
    await act(async () => {});
    expect(screen.getByText('sair do foco (Esc)')).toBeTruthy();

    fireEvent.click(screen.getByText('sair do foco (Esc)'));
    await act(async () => {});
    expect(screen.getByText('modo foco')).toBeTruthy();

    // the real button, not just the fake scene's onGoUp/handlers, must not force a remount
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(only.destroyed).toBe(false);
  });

  it('leaves a room without pushing history, so Back does not walk straight back in', async () => {
    twoMachines();
    renderPage('/office/m1');
    await act(async () => {});

    act(() => scene().handlers.onPickRoom('m1', 'p1'));
    await act(async () => {});
    expect(testSearch).toBe('?room=p1');

    escape();
    await act(async () => {});
    expect(testSearch).toBe('');

    // the spec: "the browser's back button leaves the room" — it must not put us back inside it
    await act(async () => testNavigate?.(-1));
    expect(testSearch).toBe('');
  });

  it('gives the same scene the block of a slow machine as soon as it answers', async () => {
    let resolveM2: ((s: OfficeSnapshot) => void) | undefined;
    const pendingM2 = new Promise<OfficeSnapshot>((resolve) => {
      resolveM2 = resolve;
    });
    twoMachines();
    officeMock.mockImplementation((id: string) => (id === 'm1' ? Promise.resolve(snap('m1', [room('p1', [tab('t1', 'p1')]), room('p1b', [])])) : pendingM2));
    renderPage('/office');
    await act(async () => {});

    expect(FakeOfficeScene.instances).toHaveLength(1);
    const only = scene();
    expect(only.machineIds).toEqual(['m1']); // a machine still loading is not drawn as an empty block

    await act(async () => {
      resolveM2?.(snap('m2', [room('p2', [])]));
    });
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(only.destroyed).toBe(false);
    expect(only.machineIds.slice().sort()).toEqual(['m1', 'm2']);
  });
});

describe('OfficePage rests and the URL', () => {
  it('with a single machine, /office lands on that machine and keeps ?focus=1', async () => {
    officeMock.mockResolvedValue(snap('m1', [room('p1', [tab('t1', 'p1')]), room('p1b', [tab('t1b', 'p1b')])]));
    dataState.current = { ...dataState.current, projects: [...dataState.current.projects, { id: 'p1b', machine_id: 'm1', status: 'active' }], loading: false };
    renderPage('/office?focus=1');
    await act(async () => {});

    expect(testPath).toBe('/office/m1');
    expect(testSearch).toBe('?focus=1'); // a wall display in focus mode must stay in focus mode
  });

  it('with a single machine, the ladder skips the city: room, machine, out of focus mode', async () => {
    officeMock.mockResolvedValue(snap('m1', [room('p1', [tab('t1', 'p1')])]));
    dataState.current = { ...dataState.current, loading: false };
    renderPage('/office/m1?focus=1');
    await act(async () => {});
    expect(new URLSearchParams(testSearch).get('room')).toBe('p1'); // the only room with desks

    escape();
    await act(async () => {});
    expect(testSearch).toBe('?focus=1');

    escape();
    await act(async () => {});
    // the city rung is skipped: /office with one machine would auto-drill straight back here
    expect(testPath).toBe('/office/m1');
    expect(testSearch).toBe('');
    expect(scene().targets.at(-1)).toEqual({ kind: 'machine', machineId: 'm1' });
    // the UI itself left focus mode, not just the URL: the top bar is back, the corner button is gone
    expect(screen.getByText('Escritório')).toBeTruthy();
    expect(screen.queryByText('sair do foco (Esc)')).toBeNull();
  });

  it('a zoom-out gesture never leaves focus mode, even at the rest of a single machine', async () => {
    officeMock.mockResolvedValue(snap('m1', [room('p1', [tab('t1', 'p1')]), room('p1b', [tab('t1b', 'p1b')])]));
    dataState.current = { ...dataState.current, projects: [...dataState.current.projects, { id: 'p1b', machine_id: 'm1', status: 'active' }], loading: false };
    renderPage('/office/m1?focus=1'); // two rooms with desks: no auto-drill, rests at the machine
    await act(async () => {});
    expect(testPath).toBe('/office/m1');
    expect(testSearch).toBe('?focus=1');

    // the scene's own zoom-out gesture (a wheel gesture on a wall monitor), not Esc
    act(() => scene().handlers.onGoUp());
    await act(async () => {});

    expect(testPath).toBe('/office/m1'); // still at the machine
    expect(testSearch).toBe('?focus=1'); // still in focus mode
    expect(screen.getByText('sair do foco (Esc)')).toBeTruthy();
    expect(screen.queryByText('Escritório')).toBeNull(); // top bar still absent
  });

  it('with several machines, /office rests on the city', async () => {
    twoMachines();
    renderPage('/office');
    await act(async () => {});

    expect(testPath).toBe('/office');
    expect(scene().targets.at(-1)).toEqual({ kind: 'city' });
  });

  it('sends an unknown machine back to the city', async () => {
    twoMachines();
    renderPage('/office/ghost');
    await act(async () => {});

    expect(testPath).toBe('/office');
  });

  it('never frames a room of another machine', async () => {
    twoMachines();
    renderPage('/office/m1?room=p2'); // p2 exists in the city, but on m2's block
    await act(async () => {});

    expect(scene().machineIds.slice().sort()).toEqual(['m1', 'm2']);
    expect(scene().targets.at(-1)).toEqual({ kind: 'machine', machineId: 'm1' });
  });

  it('auto-drills into the only room with desks on a direct load', async () => {
    twoMachines();
    renderPage('/office/m2'); // hal has exactly one room with desks
    await act(async () => {});

    expect(testSearch).toBe('?room=p2');
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(scene().targets.at(-1)).toEqual({ kind: 'room', machineId: 'm2', roomId: 'p2' });
  });

  it('does not auto-drill after a click on a block', async () => {
    twoMachines();
    renderPage('/office');
    await act(async () => {});

    act(() => scene().handlers.onPickMachine('m2'));
    await act(async () => {});

    // clicking a block asks for the block: the person is looking at the machine, not at one room
    expect(testPath).toBe('/office/m2');
    expect(testSearch).toBe('');
    expect(scene().targets.at(-1)).toEqual({ kind: 'machine', machineId: 'm2' });
  });

  it('auto-drills a machine reached directly after a hand-clicked visit to another machine was left with Esc', async () => {
    twoMachines(); // m1 has two rooms with desks (no drill of its own); m2 has exactly one
    renderPage('/office');
    await act(async () => {});

    act(() => scene().handlers.onPickMachine('m1'));
    await act(async () => {});
    expect(testPath).toBe('/office/m1');

    escape(); // machine -> city
    await act(async () => {});
    expect(testPath).toBe('/office');

    // arriving directly at m2 (a pasted URL, or Back/Forward) — m2 was never clicked
    await act(async () => {
      testNavigate?.('/office/m2');
    });
    expect(testSearch).toBe('?room=p2');
    expect(scene().targets.at(-1)).toEqual({ kind: 'room', machineId: 'm2', roomId: 'p2' });
  });

  it('does not re-drill a machine already left, when Back returns to its rest', async () => {
    twoMachines();
    renderPage('/office/m2'); // auto-drills into its only room, p2
    await act(async () => {});
    expect(testSearch).toBe('?room=p2');

    escape(); // room -> machine
    await act(async () => {});
    expect(testSearch).toBe('');

    // back into the room by hand, this time pushing history — so Back below is a real arrival at
    // the machine rest, not the no-op navigation to the URL the page already sits at
    act(() => scene().handlers.onPickRoom('m2', 'p2'));
    await act(async () => {});
    expect(testSearch).toBe('?room=p2');

    await act(async () => {
      testNavigate?.(-1);
    });
    expect(testPath).toBe('/office/m2');
    expect(testSearch).toBe(''); // Back left the room; the drill must not push us straight back in
  });

  it('enters a room straight from the city and keeps ?focus=1 all the way', async () => {
    twoMachines();
    renderPage('/office?focus=1');
    await act(async () => {});

    act(() => scene().handlers.onPickRoom('m2', 'p2'));
    await act(async () => {});
    expect(testPath).toBe('/office/m2');
    expect(new URLSearchParams(testSearch).get('room')).toBe('p2');
    expect(new URLSearchParams(testSearch).get('focus')).toBe('1');

    escape();
    await act(async () => {});
    expect(new URLSearchParams(testSearch).get('room')).toBeNull();
    expect(new URLSearchParams(testSearch).get('focus')).toBe('1');

    act(() => scene().handlers.onPickMachine('m1'));
    await act(async () => {});
    expect(testPath).toBe('/office/m1');
    expect(new URLSearchParams(testSearch).get('focus')).toBe('1');
  });
});

describe('OfficePage top bar', () => {
  it('renders the breadcrumb inside a room, and its city part goes back up', async () => {
    twoMachines();
    renderPage('/office/m1?room=p1');
    await act(async () => {});

    const trail = screen.getByLabelText('Trilha');
    expect(trail.textContent).toBe('Cidade›jarvis›p1');

    fireEvent.click(screen.getByRole('button', { name: 'Cidade' }));
    await act(async () => {});
    expect(testPath).toBe('/office');
    expect(scene().targets.at(-1)).toEqual({ kind: 'city' });
  });

  it('steps out to the block when the machine part is clicked inside its only room', async () => {
    twoMachines();
    // arriving straight inside a room (a v1 link, Back, or a room clicked from the city) on a
    // machine whose single room has desks: the machine part of the trail used to be a dead click,
    // because the auto-drill had never seen this machine "arrived at" and sent us back in
    renderPage('/office/m2?room=p2');
    await act(async () => {});
    expect(testSearch).toBe('?room=p2');

    fireEvent.click(screen.getByRole('button', { name: 'hal' }));
    await act(async () => {});
    expect(testPath).toBe('/office/m2');
    expect(testSearch).toBe('');
  });

  it('leaves the city part out of the breadcrumb with a single machine', async () => {
    officeMock.mockResolvedValue(snap('m1', [room('p1', [tab('t1', 'p1')])]));
    dataState.current = { ...dataState.current, loading: false };
    renderPage('/office/m1?room=p1');
    await act(async () => {});

    expect(screen.getByLabelText('Trilha').textContent).toBe('jarvis›p1');
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

  it('shows "máquina offline" at the machine rest in both modes', async () => {
    officeMock.mockResolvedValue({ ...snap('m1', [room('p1', [])]), reachable: false });
    dataState.current = { ...dataState.current, loading: false, statuses: { m1: 'offline' as const } };
    const { unmount } = renderPage('/office/m1');
    await act(async () => {});
    expect(screen.getByText('máquina offline')).toBeTruthy();
    unmount();

    renderPage('/office/m1?focus=1');
    await act(async () => {});
    expect(screen.getByText('máquina offline')).toBeTruthy();
    // an offline machine already explains the silence; the tmux notice is for a machine that answers
    expect(screen.queryByText(/sem resposta do tmux/)).toBeNull();
  });

  it('says so when a machine that answers cannot read its tmux', async () => {
    officeMock.mockResolvedValue({ ...snap('m1', [room('p1', [])]), reachable: false });
    dataState.current = { ...dataState.current, loading: false };
    renderPage('/office/m1');
    await act(async () => {});

    expect(screen.getByText('sem resposta do tmux: estado pode estar desatualizado')).toBeTruthy();
  });

  it('says so at the machine rest when that machine\'s snapshot could not be read', async () => {
    officeMock.mockRejectedValue(new Error('nope'));
    dataState.current = { ...dataState.current, loading: false };
    const { unmount } = renderPage('/office/m1');
    await act(async () => {});
    // its block is drawn empty and its own sign is hidden at its rest: without this the page is a
    // blank diamond with no words at all on a single-machine account
    expect(screen.getByText('Não foi possível carregar o escritório desta máquina.')).toBeTruthy();
    // and not the "no projects yet" line, which would be a lie about a machine we could not read
    expect(screen.queryByText('Esta máquina ainda não tem projetos.')).toBeNull();
    unmount();

    renderPage('/office/m1?focus=1');
    await act(async () => {});
    expect(screen.getByText('Não foi possível carregar o escritório desta máquina.')).toBeTruthy();
  });

  it('keeps the failed read out of the city rest, where the block\'s sign says it', async () => {
    twoMachines();
    officeMock.mockImplementation((id: string) => (id === 'm1' ? Promise.reject(new Error('nope')) : Promise.resolve(snap('m2', [room('p2', [tab('t2', 'p2')])]))));
    renderPage('/office');
    await act(async () => {});

    expect(testPath).toBe('/office');
    expect(screen.queryByText('Não foi possível carregar o escritório desta máquina.')).toBeNull();
  });

  it('keeps one machine\'s notices out of the city rest, where the block\'s sign says it', async () => {
    twoMachines();
    dataState.current = { ...dataState.current, statuses: { m1: 'offline', m2: 'online' } };
    renderPage('/office');
    await act(async () => {});

    expect(testPath).toBe('/office');
    expect(screen.queryByText('máquina offline')).toBeNull();
  });
});

describe('OfficePage share button', () => {
  // owned by 'u1' unless told otherwise — the signed-in viewer in every test below, except the one
  // that deliberately looks at a machine owned by someone else (view-as/view-all)
  const pMachine = (id: string, name: string, ownerId: string | null = 'u1'): Machine => ({ id, name, public_id: `${id}-pub`, owner_id: ownerId }) as Machine;
  const pProject = (id: string, isPublic: boolean): Project => ({ id, name: id, status: 'active', public_id: `${id}-pub`, is_public: isPublic }) as Project;
  const pRoom = (id: string, isPublic: boolean, tabs: OfficeTab[] = []): OfficeRoom => ({ project: pProject(id, isPublic), tabs, tasks: null });

  /** m1 has two rooms with desks (p1 published, p1b not); m2 has two rooms with desks, neither published. Both owned by `owners.m1`/`owners.m2` (default 'u1', the viewer). */
  function twoMachinesOnePublished(owners: { m1?: string | null; m2?: string | null } = {}) {
    dataState.current = {
      machines: [pMachine('m1', 'jarvis', owners.m1 ?? 'u1'), pMachine('m2', 'hal', owners.m2 ?? 'u1')],
      projects: [
        { id: 'p1', machine_id: 'm1', status: 'active' },
        { id: 'p1b', machine_id: 'm1', status: 'active' },
        { id: 'p2', machine_id: 'm2', status: 'active' },
        { id: 'p2b', machine_id: 'm2', status: 'active' },
      ],
      statuses: { m1: 'online', m2: 'online' },
      loading: false,
    };
    officeMock.mockImplementation((id: string) =>
      Promise.resolve(
        id === 'm1'
          ? snap('m1', [pRoom('p1', true, [tab('t1', 'p1')]), pRoom('p1b', false, [tab('t1b', 'p1b')])])
          : snap('m2', [pRoom('p2', false, [tab('t2', 'p2')]), pRoom('p2b', false, [tab('t2b', 'p2b')])]),
      ),
    );
  }

  function stubClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  }

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it("copies the city's own address when something anywhere is published", async () => {
    const writeText = stubClipboard();
    authState.current = { user: { id: 'u1', nickname: 'pedro' } as User };
    twoMachinesOnePublished();
    renderPage('/office');
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: /compartilhar/i }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('https://termhub.dev/city/@pedro');
  });

  it("copies the building's address inside a machine, using the machine's public id", async () => {
    const writeText = stubClipboard();
    authState.current = { user: { id: 'u1', nickname: 'pedro' } as User };
    twoMachinesOnePublished();
    renderPage('/office/m1');
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: /compartilhar/i }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('https://termhub.dev/city/@pedro/m1-pub');
  });

  it("copies the room's address inside a room, using the project's public id", async () => {
    const writeText = stubClipboard();
    authState.current = { user: { id: 'u1', nickname: 'pedro' } as User };
    twoMachinesOnePublished();
    renderPage('/office/m1?room=p1');
    await act(async () => {});

    fireEvent.click(screen.getByRole('button', { name: /compartilhar/i }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith('https://termhub.dev/city/@pedro/m1-pub?room=p1-pub');
  });

  it('explains itself instead of copying when nothing in view is published', async () => {
    const writeText = stubClipboard();
    authState.current = { user: { id: 'u1', nickname: 'pedro' } as User };
    twoMachinesOnePublished();
    renderPage('/office/m2'); // both of hal's rooms are unpublished
    await act(async () => {});

    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/nada publicado/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('produces no link for a machine whose owner is not the viewer (view-as/view-all)', async () => {
    const writeText = stubClipboard();
    // the signed-in person is 'u1' (an admin, say), but m1 here belongs to someone else ('u2') and
    // has a published room — a nickname of 'u1' would either be missing or point at the wrong city
    authState.current = { user: { id: 'u1', nickname: 'pedro' } as User };
    twoMachinesOnePublished({ m1: 'u2', m2: 'u2' });
    renderPage('/office/m1');
    await act(async () => {});

    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/pertence a outra pessoa/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not build the city link from an admin's own nickname when only someone else's machine is published", async () => {
    const writeText = stubClipboard();
    authState.current = { user: { id: 'u1', nickname: 'pedro' } as User };
    twoMachinesOnePublished({ m1: 'u2', m2: 'u2' }); // nothing here is 'u1's own
    renderPage('/office');
    await act(async () => {});

    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/pertence a outra pessoa/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });
});
