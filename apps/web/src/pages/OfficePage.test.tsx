// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OfficeBuilding, OfficeCity, OfficeMachine, OfficeTab, Project, User } from '../lib/types';

// vi.mock factories are hoisted above every other top-level statement in this file, including this
// file's own `import { OfficePage } from './OfficePage'` below — so everything a factory needs to
// reference has to be created through vi.hoisted(), not as a plain top-level const/class.
const { officeMock, canMock, monitorState, authState, FakeOfficeScene } = vi.hoisted(() => {
  /**
   * Pins the scene-mount effect's stability: no WebGL in jsdom, so `OfficeScene` itself is replaced
   * with a spy-able stand-in that records what the page does to it, instead of drawing anything.
   */
  type Target = { kind: 'city' } | { kind: 'building'; projectId: string };
  class FakeOfficeScene {
    static instances: FakeOfficeScene[] = [];
    handlers: { onPickDesk: (tabId: string, projectId: string) => void; onPickBuilding: (projectId: string) => void; onPickSign: (projectId: string) => void; onGoUp: () => void };
    models: Array<{ buildings: Array<{ id: string; notice: string | null; desks: Array<{ id: string; machine: unknown }> }> }> = [];
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
    /** which buildings the last model the page handed over carries */
    get buildingIds(): string[] {
      return (this.models.at(-1)?.buildings ?? []).map((b) => b.id);
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
    canMock: vi.fn((_resource: string, _action?: string) => true),
    // mutable containers: the mocked hooks below read `.current` fresh on every call
    monitorState: { current: { items: [] as unknown[], needsYou: [] as unknown[], tabState: () => undefined, connected: true } },
    // null by default: the share button must stay out of the way (a quiet "nothing published" span)
    authState: { current: { user: null as User | null, publicCityUrl: 'https://termhub.dev/city' as string | null } },
    FakeOfficeScene,
  };
});

const { cityLinkState } = vi.hoisted(() => ({ cityLinkState: { current: { link: null as { short_url: string | null } | null } } }));
vi.mock('../lib/city-link', () => ({ useCityLink: () => cityLinkState.current }));
vi.mock('../office/scene/OfficeScene', () => ({ OfficeScene: FakeOfficeScene }));
vi.mock('../lib/api', () => ({ api: { office: (...a: unknown[]) => officeMock(...a) } }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: canMock, user: authState.current.user, publicCityUrl: authState.current.publicCityUrl }) }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => monitorState.current }));

import { FocusProvider } from '../lib/focus';
import { OfficePage } from './OfficePage';

const tab = (id: string, projectId: string, machineId = 'm1'): OfficeTab => ({
  id, project_id: projectId, machine_id: machineId, name: id, kind: 'terminal', tmux_session: null, simulator_udid: null, position: 0,
  state: null, state_text: null, state_tool: null, state_at: null, state_seen_at: null, activity: null, activity_verb: null, created_at: '', alive: true, progress: null,
});
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, name: id, status: 'active', owner_id: 'u1', is_public: false, public_id: `${id}-pub`, ...over }) as Project;
const building = (id: string, tabs: OfficeTab[] = [], over: Partial<Project> = {}): OfficeBuilding => ({ project: project(id, over), public_id: `${id}-pub`, tabs, tasks: null });
const machine = (id: string, name: string, over: Partial<OfficeMachine> = {}): OfficeMachine => ({ id, name, subtitle: null, type: 'agent', online: true, reachable: true, ...over });
const MACHINES = [machine('m1', 'jarvis', { subtitle: 'MacBook do escritório' }), machine('m2', 'hal')];
const cityOf = (projects: OfficeBuilding[], machines: OfficeMachine[] = MACHINES): OfficeCity => ({ projects, machines });

/** p1 runs on jarvis and hal, p2 on hal: two buildings, so /office rests on the city. */
function twoProjects(over: { p1?: Partial<Project>; p2?: Partial<Project> } = {}, machines: OfficeMachine[] = MACHINES) {
  officeMock.mockResolvedValue(cityOf([building('p1', [tab('t1', 'p1', 'm1'), tab('t1b', 'p1', 'm2')], over.p1), building('p2', [tab('t2', 'p2', 'm2')], over.p2)], machines));
}
/** one project: /office is its building */
function oneProject(machines: OfficeMachine[] = MACHINES) {
  officeMock.mockResolvedValue(cityOf([building('p1', [tab('t1', 'p1', 'm1')])], machines));
}

// lets a test drive real react-router navigation (path AND query string) the same way a production
// click or a pasted URL would — the rests of the office are URLs, so every move is read back from them
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
        <Route path="/office/:projectId" element={<OfficePage />} />
      </Routes>
    </FocusProvider>
  </MemoryRouter>
);

function renderPage(initialEntry = '/office') {
  return render(tree(initialEntry));
}

const scene = () => FakeOfficeScene.instances[0];
const escape = () => fireEvent.keyDown(document.body, { key: 'Escape' });
const pedro = () => (authState.current = { ...authState.current, user: { id: 'u1', nickname: 'pedro' } as User });

beforeEach(() => {
  FakeOfficeScene.instances = [];
  cityLinkState.current = { link: null };
  officeMock.mockReset();
  canMock.mockReset();
  canMock.mockReturnValue(true);
  testNavigate = undefined;
  testPath = '';
  testSearch = '';
  monitorState.current = { items: [], needsYou: [], tabState: () => undefined, connected: true };
  authState.current = { user: null, publicCityUrl: 'https://termhub.dev/city' };
});

afterEach(() => {
  cleanup();
});

describe('OfficePage scene lifecycle', () => {
  it('builds one scene once the city is read, and hands it every building', async () => {
    let resolve!: (c: OfficeCity) => void;
    officeMock.mockReturnValue(new Promise<OfficeCity>((r) => (resolve = r)));
    renderPage('/office');
    await act(async () => {});
    // still reading: there is no host to mount on yet
    expect(FakeOfficeScene.instances).toHaveLength(0);
    expect(screen.getByText('Carregando…')).toBeTruthy();
    await act(async () => resolve(cityOf([building('p1', [tab('t1', 'p1')]), building('p2')])));
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(scene().buildingIds).toEqual(['p1', 'p2']);
  });

  it('reads the whole city in one request', async () => {
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);
    expect(officeMock).toHaveBeenCalledWith(false);
  });

  it('keeps the same scene from the city into a building and back up', async () => {
    twoProjects();
    renderPage('/office?focus=1');
    await act(async () => {});
    const only = scene();
    act(() => only.handlers.onPickBuilding('p1'));
    await act(async () => {});
    expect(testPath).toBe('/office/p1');
    expect(new URLSearchParams(testSearch).get('focus')).toBe('1');
    escape();
    await act(async () => {});
    expect(testPath).toBe('/office');
    // every rest of the walk is a camera move on ONE scene: the canvas never blanks
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(only.destroyed).toBe(false);
    expect(only.targets.slice(-2)).toEqual([{ kind: 'building', projectId: 'p1' }, { kind: 'city' }]);
  });

  it('keeps the same scene when focus mode is toggled by the real button', async () => {
    twoProjects();
    renderPage('/office/p1');
    await act(async () => {});
    const only = scene();
    fireEvent.click(screen.getByText('modo foco'));
    await act(async () => {});
    expect(screen.getByText('sair do foco (Esc)')).toBeTruthy();
    fireEvent.click(screen.getByText('sair do foco (Esc)'));
    await act(async () => {});
    expect(screen.getByText('modo foco')).toBeTruthy();
    expect(FakeOfficeScene.instances).toHaveLength(1);
    expect(only.destroyed).toBe(false);
  });

  it('leaves a building without pushing history, so Back does not walk straight back in', async () => {
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    act(() => scene().handlers.onPickBuilding('p2'));
    await act(async () => {});
    expect(testPath).toBe('/office/p2');
    escape();
    await act(async () => {});
    expect(testPath).toBe('/office');
    await act(async () => testNavigate?.(-1));
    expect(testPath).toBe('/office');
  });

  it("opens a desk's terminal in a new tab, and the building sign opens its project", async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    twoProjects();
    renderPage('/office/p1');
    await act(async () => {});
    act(() => scene().handlers.onPickDesk('t1', 'p1'));
    expect(open).toHaveBeenCalledWith('/projects/p1?tab=t1', '_blank', 'noopener');
    open.mockRestore();
    act(() => scene().handlers.onPickSign('p1'));
    await act(async () => {});
    expect(testPath).toBe('/projects/p1');
  });
});

describe('OfficePage rests and the URL', () => {
  it('with a single project, /office lands on its building and keeps ?focus=1', async () => {
    oneProject();
    renderPage('/office?focus=1');
    await act(async () => {});
    expect(testPath).toBe('/office/p1');
    expect(testSearch).toBe('?focus=1');
  });

  it('with a single project, the ladder skips the city: Esc leaves focus mode', async () => {
    oneProject();
    renderPage('/office/p1?focus=1');
    await act(async () => {});
    escape();
    await act(async () => {});
    // the city rung is skipped: /office with one project would auto-drill straight back here
    expect(testPath).toBe('/office/p1');
    expect(testSearch).toBe('');
    expect(scene().targets.at(-1)).toEqual({ kind: 'building', projectId: 'p1' });
    expect(screen.getByText('Escritório')).toBeTruthy();
    expect(screen.queryByText('sair do foco (Esc)')).toBeNull();
  });

  it('a zoom-out gesture never leaves focus mode', async () => {
    oneProject();
    renderPage('/office/p1?focus=1');
    await act(async () => {});
    act(() => scene().handlers.onGoUp());
    await act(async () => {});
    expect(testPath).toBe('/office/p1');
    expect(testSearch).toBe('?focus=1');
    expect(screen.getByText('sair do foco (Esc)')).toBeTruthy();
  });

  it('with several projects, /office rests on the city', async () => {
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    expect(testPath).toBe('/office');
    expect(scene().targets.at(-1)).toEqual({ kind: 'city' });
  });

  it('frames the building of the project in the URL on a direct load', async () => {
    twoProjects();
    renderPage('/office/p2');
    await act(async () => {});
    expect(scene().targets.at(-1)).toEqual({ kind: 'building', projectId: 'p2' });
  });

  // city-by-project §7: a /office/:machineId bookmark, with the old office's ?room=, is the city
  it('sends an unknown project — an old machine bookmark — back to the city, keeping focus and dropping ?room=', async () => {
    twoProjects();
    renderPage('/office/m1?room=p1&focus=1');
    await act(async () => {});
    expect(testPath).toBe('/office');
    expect(testSearch).toBe('?focus=1');
  });

  it('re-reads the city, fresh, when the monitor names a tab it lacks — once per tab', async () => {
    twoProjects();
    const { rerender } = renderPage('/office');
    await act(async () => {});
    expect(officeMock).toHaveBeenCalledTimes(1);
    monitorState.current = { ...monitorState.current, items: [{ tab: { id: 'new' }, project: { id: 'p1' } }] };
    await act(async () => {
      rerender(tree('/office'));
    });
    expect(officeMock).toHaveBeenCalledTimes(2);
    expect(officeMock).toHaveBeenLastCalledWith(true);
    await act(async () => {
      rerender(tree('/office'));
    });
    expect(officeMock).toHaveBeenCalledTimes(2);
  });

  it('reads nothing and goes home without the grants to see the office', async () => {
    canMock.mockImplementation((resource: string) => resource !== 'terminals');
    renderPage('/office');
    await act(async () => {});
    expect(officeMock).not.toHaveBeenCalled();
    expect(testPath).toBe('/');
  });

  it('says there is nothing to draw without projects', async () => {
    officeMock.mockResolvedValue(cityOf([], []));
    renderPage('/office');
    await act(async () => {});
    expect(screen.getByText(/Nenhum projeto ainda/)).toBeTruthy();
    expect(FakeOfficeScene.instances).toHaveLength(0);
  });

  it('says so when the city could not be read', async () => {
    officeMock.mockRejectedValue(new Error('nope'));
    renderPage('/office');
    await act(async () => {});
    expect(screen.getByText('Não foi possível carregar o escritório. Tentando de novo…')).toBeTruthy();
  });
});

describe('OfficePage desks', () => {
  // city-by-project §1: the machine is a detail of the desk, not a place
  it('hands the scene every desk with the machine it runs on', async () => {
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    const p1 = scene().models.at(-1)!.buildings.find((b) => b.id === 'p1')!;
    expect(p1.desks.map((d) => [d.id, d.machine])).toEqual([
      ['t1', { name: 'jarvis', subtitle: 'MacBook do escritório', online: true }],
      ['t1b', { name: 'hal', subtitle: null, online: true }],
    ]);
  });
});

describe('OfficePage top bar', () => {
  it('renders the trail at a building, and its city part goes back up', async () => {
    twoProjects();
    renderPage('/office/p1');
    await act(async () => {});
    expect(screen.getByLabelText('Trilha').textContent).toBe('Cidade›p1');
    fireEvent.click(screen.getByRole('button', { name: 'Cidade' }));
    await act(async () => {});
    expect(testPath).toBe('/office');
    expect(scene().targets.at(-1)).toEqual({ kind: 'city' });
  });

  it('leaves the city part out of the trail with a single project', async () => {
    oneProject();
    renderPage('/office/p1');
    await act(async () => {});
    expect(screen.getByLabelText('Trilha').textContent).toBe('p1');
  });

  it('is the shared page header: Escritório as the only title, the trail and the actions in it', async () => {
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Escritório']);
    const header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    expect(header.contains(screen.getByLabelText('Trilha'))).toBe(true);
    expect(header.contains(screen.getByText('modo foco'))).toBe(true);
  });
});

describe('OfficePage status notices', () => {
  // focus mode is the second monitor left open all day: a dropped WebSocket there must not be a
  // frozen picture that looks live
  it('shows "reconectando…" in focus mode, where the top bar is gone', async () => {
    oneProject();
    monitorState.current = { ...monitorState.current, connected: false };
    renderPage('/office/p1?focus=1');
    await act(async () => {});
    expect(screen.getByText('sair do foco (Esc)')).toBeTruthy();
    expect(screen.queryByText('modo foco')).toBeNull();
    expect(screen.getByText('reconectando…')).toBeTruthy();
  });

  it('shows "máquina offline" at a building whose every machine is offline, in both modes', async () => {
    oneProject([machine('m1', 'jarvis', { online: false, reachable: false })]);
    const { unmount } = renderPage('/office/p1');
    await act(async () => {});
    expect(screen.getByText('máquina offline')).toBeTruthy();
    unmount();
    renderPage('/office/p1?focus=1');
    await act(async () => {});
    expect(screen.getByText('máquina offline')).toBeTruthy();
    // an offline machine already explains the silence; the tmux notice is for a machine that answers
    expect(screen.queryByText(/tmux sem resposta/)).toBeNull();
  });

  it('says so when a machine of the building cannot read its tmux', async () => {
    oneProject([machine('m1', 'jarvis', { reachable: false })]);
    renderPage('/office/p1');
    await act(async () => {});
    // compact in the header: a short label, the whole sentence for hover and screen readers
    const notice = screen.getByLabelText('sem resposta do tmux: estado pode estar desatualizado');
    expect(notice.textContent).toBe('tmux sem resposta');
    expect(notice.getAttribute('title')).toBe('sem resposta do tmux: estado pode estar desatualizado');
    expect(notice.querySelector('svg')).not.toBeNull();
  });

  it("keeps a building's notices out of the city rest, where its sign says it", async () => {
    twoProjects({}, [machine('m1', 'jarvis', { online: false, reachable: false }), machine('m2', 'hal', { online: false, reachable: false })]);
    renderPage('/office');
    await act(async () => {});
    expect(testPath).toBe('/office');
    expect(screen.queryByText('máquina offline')).toBeNull();
  });
});

describe('OfficePage share button', () => {
  function stubClipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    return writeText;
  }

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  async function share() {
    fireEvent.click(screen.getByRole('button', { name: /compartilhar/i }));
    await act(async () => {});
  }

  it("copies the city's own address when one of the viewer's projects is published", async () => {
    const writeText = stubClipboard();
    pedro();
    twoProjects({ p1: { is_public: true } });
    renderPage('/office');
    await act(async () => {});
    await share();
    expect(writeText).toHaveBeenCalledWith('https://termhub.dev/city/@pedro');
  });

  it('copies the short link at the city, when there is one', async () => {
    const writeText = stubClipboard();
    pedro();
    cityLinkState.current = { link: { short_url: 'https://77a.it/pedro' } };
    twoProjects({ p1: { is_public: true } });
    renderPage('/office');
    await act(async () => {});
    await share();
    expect(writeText).toHaveBeenCalledWith('https://77a.it/pedro');
  });

  // city-by-project §3.3: a building's link is the base plus its project's public id
  it("copies a building's address from its project's public id, even with a short link", async () => {
    const writeText = stubClipboard();
    pedro();
    cityLinkState.current = { link: { short_url: 'https://77a.it/pedro' } };
    twoProjects({ p1: { is_public: true } });
    renderPage('/office/p1');
    await act(async () => {});
    await share();
    expect(writeText).toHaveBeenCalledWith('https://termhub.dev/city/@pedro/p1-pub');
  });

  // A self-hosted instance: the link is its own public-city address, as the server reports it.
  it("builds the link from this instance's own public-city address, never termhub.dev", async () => {
    const writeText = stubClipboard();
    authState.current = { user: { id: 'u1', nickname: 'pedro' } as User, publicCityUrl: 'https://th.example.org/city' };
    twoProjects({ p1: { is_public: true } });
    renderPage('/office/p1');
    await act(async () => {});
    await share();
    expect(writeText).toHaveBeenCalledWith('https://th.example.org/city/@pedro/p1-pub');
  });

  // §2.4: a published project is always on the street, whatever machines its agents use
  it("shares the viewer's published project even when its agents run on other machines, and never says 'máquina de outra pessoa'", async () => {
    const writeText = stubClipboard();
    pedro();
    twoProjects({ p1: { is_public: true } });
    renderPage('/office/p1');
    await act(async () => {});
    expect(screen.queryByText(/máquina de outra pessoa/i)).toBeNull();
    await share();
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('explains itself instead of copying when the project in view is not published', async () => {
    const writeText = stubClipboard();
    pedro();
    twoProjects({ p1: { is_public: true } });
    renderPage('/office/p2');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/nada publicado/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('explains itself at the city while nothing is published', async () => {
    pedro();
    twoProjects();
    renderPage('/office');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/nada publicado/i)).toBeTruthy();
  });

  it('produces no link for a published project whose owner is not the viewer (view-as/view-all)', async () => {
    const writeText = stubClipboard();
    pedro();
    twoProjects({ p1: { is_public: true, owner_id: 'u2' } });
    renderPage('/office/p1');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/pertence a outra pessoa/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not build the city link from an admin's own nickname when only someone else's project is published", async () => {
    const writeText = stubClipboard();
    pedro();
    twoProjects({ p1: { is_public: true, owner_id: 'u2' } });
    renderPage('/office');
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /compartilhar/i })).toBeNull();
    expect(screen.getByText(/pertence a outra pessoa/i)).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
  });
});
