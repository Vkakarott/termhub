// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project, ProjectGroup, Tab } from '../lib/types';

// the same mocks as Sidebar.test.tsx (vi.mock is hoisted per file, so they cannot be shared)
const state = vi.hoisted(() => ({ projects: [] as Project[], openTabs: [] as Tab[] }));
vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'pedro@example.com' }, logout: vi.fn(), can: () => true, viewAs: 'self' }),
}));
const groupsState = vi.hoisted(() => ({
  groups: [] as import('../lib/types').ProjectGroup[],
  error: null as string | null,
  createGroup: vi.fn(async (_name: string) => null as import('../lib/types').ProjectGroup | null),
  renameGroup: vi.fn(async (_id: string, _name: string) => {}),
  deleteGroup: vi.fn(async (_id: string) => {}),
  reorderGroups: vi.fn(async (_id: string, _toIndex: number) => {}),
  setMemberships: vi.fn(async (_next: unknown, _changes: unknown) => {}),
  reload: vi.fn(async () => {}),
  toggleFavorite: vi.fn(async (_id: string) => {}),
  isFavorite: (id: string): boolean => groupsState.groups.some((g) => g.kind === 'favorites' && g.project_ids.includes(id)),
}));
vi.mock('../lib/project-groups', () => ({ useProjectGroups: () => groupsState }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ items: [], openTabs: state.openTabs, needsYou: [] }) }));
vi.mock('../lib/data', () => ({
  useData: () => ({ machines: [] as Machine[], projects: state.projects, loading: false, deleteProject: vi.fn(), machinesOf: () => [] }),
}));

import { Sidebar } from './Sidebar';

const project = (id: string, name: string): Project =>
  ({ id, key: name.toUpperCase(), name, status: 'active', machines: [{ machine_id: 'm1', cwd: '/a', position: 0 }] }) as Project;
const fav = (ids: string[] = []): ProjectGroup => ({ id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ids });
const custom = (id: string, name: string, position: number, ids: string[] = []): ProjectGroup => ({ id, name, kind: 'custom', position, project_ids: ids });

/** alpha (p1): running · beta (p2), gamma (p3): idle */
beforeEach(() => {
  state.projects = [project('p1', 'alpha'), project('p2', 'beta'), project('p3', 'gamma')];
  state.openTabs = [{ id: 't1', name: 'Ana', project_id: 'p1', machine_id: 'm1', kind: 'terminal', position: 0, state: 'working' } as Tab];
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  groupsState.groups = [];
  vi.clearAllMocks();
});

const mount = () =>
  render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );

/** a stand-in for the browser's DataTransfer (jsdom has none); like a browser, `types` lists what setData stored */
const dt = () => {
  const store: Record<string, string> = {};
  const types: string[] = [];
  return {
    setData: (k: string, v: string) => {
      if (!types.includes(k)) types.push(k);
      store[k] = v;
    },
    getData: (k: string) => store[k] ?? '',
    effectAllowed: '',
    dropEffect: '',
    types,
  };
};
/** the same transfer as a real browser shows it during dragover: the types are readable, the data is not */
const protectedView = (data: Data): Data => ({ ...data, getData: () => '' });
type Data = ReturnType<typeof dt>;
/**
 * Fires a drag event. jsdom has no DragEvent, so the plain Event it falls back to drops `altKey` and `clientY`:
 * they are set on the event by hand. Returns false when a handler called preventDefault (the target accepts).
 */
const drag = (type: 'dragStart' | 'dragOver' | 'drop' | 'dragEnd', el: Element, dataTransfer: Data, extra: { altKey?: boolean; clientY?: number } = {}) => {
  const event = createEvent[type](el, { dataTransfer });
  for (const [k, v] of Object.entries(extra)) Object.defineProperty(event, k, { value: v });
  return fireEvent(el, event);
};
const region = (name: string) => screen.getByRole('region', { name });
const rowIn = (name: string, projectName: string) => within(region(name)).getByRole('link', { name: new RegExp(projectName) }).closest('li')!;
const hintIn = (name: string) => within(region(name)).getByText('arraste projetos para cá');
const headerOf = (name: string) => within(region(name)).getByText(name, { selector: 'span' }).closest('div')!;

describe('Sidebar drag and drop: projects', () => {
  it('every project row is draggable, in every section', () => {
    groupsState.groups = [custom('g1', 'Clientes', 0, ['p2'])];
    mount();
    expect(rowIn('Em execução', 'alpha')).toHaveAttribute('draggable', 'true');
    expect(rowIn('Clientes', 'beta')).toHaveAttribute('draggable', 'true');
    expect(rowIn('Outros', 'gamma')).toHaveAttribute('draggable', 'true');
  });

  it('Outros → group adds the project', () => {
    groupsState.groups = [custom('g1', 'Clientes', 0)];
    mount();
    const data = dt();
    drag('dragStart', rowIn('Outros', 'gamma'), data);
    expect(data.effectAllowed).toBe('copyMove');
    expect(drag('dragOver', hintIn('Clientes'), data)).toBe(false);
    drag('drop', hintIn('Clientes'), data);
    expect(groupsState.setMemberships).toHaveBeenCalledWith(expect.anything(), [{ id: 'g1', project_ids: ['p3'] }]);
  });

  it('Em execução → group adds the project', () => {
    groupsState.groups = [custom('g1', 'Clientes', 0)];
    mount();
    const data = dt();
    drag('dragStart', rowIn('Em execução', 'alpha'), data);
    drag('drop', hintIn('Clientes'), data);
    expect(groupsState.setMemberships).toHaveBeenCalledWith(expect.anything(), [{ id: 'g1', project_ids: ['p1'] }]);
  });

  it('group → group moves, and with Alt copies', () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1, ['p3'])];
    mount();
    let data = dt();
    drag('dragStart', rowIn('Clientes', 'gamma'), data);
    drag('dragOver', hintIn('Favoritos'), data);
    expect(data.dropEffect).toBe('move');
    drag('drop', hintIn('Favoritos'), data);
    expect(groupsState.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [
      { id: 'g1', project_ids: [] },
      { id: 'fav', project_ids: ['p3'] },
    ]);

    data = dt();
    drag('dragStart', rowIn('Clientes', 'gamma'), data);
    drag('dragOver', hintIn('Favoritos'), data, { altKey: true });
    expect(data.dropEffect).toBe('copy');
    drag('drop', hintIn('Favoritos'), data, { altKey: true });
    expect(groupsState.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [{ id: 'fav', project_ids: ['p3'] }]);
  });

  it('Alt from Outros is still a move: there is no group to copy from', () => {
    groupsState.groups = [custom('g1', 'Clientes', 0)];
    mount();
    const data = dt();
    drag('dragStart', rowIn('Outros', 'gamma'), data);
    drag('dragOver', hintIn('Clientes'), data, { altKey: true });
    expect(data.dropEffect).toBe('move');
  });

  it('dropping on a row places the project before it in its top half, after it in the bottom half', () => {
    groupsState.groups = [custom('g1', 'Clientes', 0, ['p2', 'p3'])];
    mount();
    const beta = rowIn('Clientes', 'beta');
    beta.getBoundingClientRect = () => ({ top: 100, height: 20, bottom: 120, left: 0, right: 0, width: 0, x: 0, y: 100, toJSON: () => ({}) });
    const data = dt();
    drag('dragStart', rowIn('Clientes', 'gamma'), data);
    drag('dragOver', beta, data, { clientY: 105 });
    // the drop position shows as an accent line on the row at that slot
    expect(beta).toHaveClass('border-t-2', 'border-accent');
    drag('drop', beta, data, { clientY: 105 });
    expect(groupsState.setMemberships).toHaveBeenCalledWith(expect.anything(), [{ id: 'g1', project_ids: ['p3', 'p2'] }]);
    expect(beta).not.toHaveClass('border-t-2');

    // Outros → the bottom half of beta: between beta and gamma
    const alt = dt();
    drag('dragStart', rowIn('Em execução', 'alpha'), alt);
    drag('drop', beta, alt, { clientY: 115 });
    expect(groupsState.setMemberships).toHaveBeenLastCalledWith(expect.anything(), [{ id: 'g1', project_ids: ['p2', 'p1', 'p3'] }]);
  });

  it('a slot counts visible rows but lands at the right place among hidden (archived) members', () => {
    state.projects = [...state.projects, { ...project('p9', 'zeta'), status: 'archived' }];
    groupsState.groups = [custom('g1', 'Clientes', 0, ['p9', 'p2'])];
    mount();
    const data = dt();
    drag('dragStart', rowIn('Outros', 'gamma'), data);
    // top half of beta (visible slot 0) = before beta, after the hidden zeta
    drag('drop', rowIn('Clientes', 'beta'), data, { clientY: -1 });
    expect(groupsState.setMemberships).toHaveBeenCalledWith(expect.anything(), [{ id: 'g1', project_ids: ['p9', 'p3', 'p2'] }]);
  });

  it('dropping on a group header adds at the end, even when the group is collapsed', () => {
    groupsState.groups = [custom('g1', 'Clientes', 0, ['p2'])];
    mount();
    fireEvent.click(within(region('Clientes')).getByRole('button', { name: 'Recolher Clientes' }));
    const data = dt();
    drag('dragStart', rowIn('Outros', 'gamma'), data);
    expect(drag('dragOver', headerOf('Clientes'), data)).toBe(false);
    drag('drop', headerOf('Clientes'), data);
    expect(groupsState.setMemberships).toHaveBeenCalledWith(expect.anything(), [{ id: 'g1', project_ids: ['p2', 'p3'] }]);
    // a project over a header never reorders groups
    expect(groupsState.reorderGroups).not.toHaveBeenCalled();
  });

  it('group → Outros removes from that group', () => {
    groupsState.groups = [custom('g1', 'Clientes', 0, ['p3'])];
    mount();
    const data = dt();
    drag('dragStart', rowIn('Clientes', 'gamma'), data);
    expect(drag('dragOver', region('Outros'), data)).toBe(false);
    drag('drop', region('Outros'), data);
    expect(groupsState.setMemberships).toHaveBeenCalledWith(expect.anything(), [{ id: 'g1', project_ids: [] }]);
  });

  it('Em execução is not a drop target', () => {
    groupsState.groups = [custom('g1', 'Clientes', 0, ['p1'])];
    mount(); // alpha (p1) is running
    const data = dt();
    drag('dragStart', rowIn('Clientes', 'alpha'), data);
    // dragover not cancelled = the browser refuses the drop
    expect(drag('dragOver', region('Em execução'), data)).toBe(true);
    expect(drag('dragOver', rowIn('Em execução', 'alpha'), data)).toBe(true);
    drag('drop', region('Em execução'), data);
    drag('drop', rowIn('Em execução', 'alpha'), data);
    expect(groupsState.setMemberships).not.toHaveBeenCalled();
  });

  it('dragend clears the drop line', () => {
    groupsState.groups = [custom('g1', 'Clientes', 0, ['p2'])];
    mount();
    const data = dt();
    const source = rowIn('Outros', 'gamma');
    drag('dragStart', source, data);
    drag('dragOver', rowIn('Clientes', 'beta'), data, { clientY: -1 });
    expect(rowIn('Clientes', 'beta')).toHaveClass('border-t-2');
    drag('dragEnd', source, data);
    expect(rowIn('Clientes', 'beta')).not.toHaveClass('border-t-2');
  });
});

describe('Sidebar drag and drop: what counts as our drag', () => {
  it('during dragover the data is hidden (real browsers): the drag in progress is recognised by its type', () => {
    groupsState.groups = [custom('g1', 'Clientes', 0)];
    mount();
    const data = dt();
    drag('dragStart', rowIn('Outros', 'gamma'), data);
    expect(drag('dragOver', hintIn('Clientes'), protectedView(data))).toBe(false);
    drag('drop', hintIn('Clientes'), protectedView(data));
    expect(groupsState.setMemberships).toHaveBeenCalledWith(expect.anything(), [{ id: 'g1', project_ids: ['p3'] }]);
  });

  it('a foreign drag (an OS file) is not taken for a stale sidebar drag', () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1)];
    mount();
    // a project drag and a group drag start, and their source goes away without a dragend
    drag('dragStart', rowIn('Outros', 'gamma'), dt());
    const file = { ...dt(), types: ['Files'] };
    expect(drag('dragOver', hintIn('Clientes'), file)).toBe(true);
    drag('drop', hintIn('Clientes'), file);
    drag('dragStart', headerOf('Clientes'), dt());
    expect(drag('dragOver', headerOf('Favoritos'), file)).toBe(true);
    drag('drop', headerOf('Favoritos'), file);
    expect(groupsState.setMemberships).not.toHaveBeenCalled();
    expect(groupsState.reorderGroups).not.toHaveBeenCalled();
  });
});

describe('Sidebar drag and drop: groups', () => {
  it('dragging a group header onto another reorders groups', () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1)];
    mount();
    const data = dt();
    drag('dragStart', within(region('Clientes')).getByText('Clientes'), data);
    const favHeader = within(region('Favoritos')).getByText('Favoritos');
    expect(drag('dragOver', favHeader, data)).toBe(false);
    drag('drop', favHeader, data);
    expect(groupsState.reorderGroups).toHaveBeenCalledWith('g1', 0);
    expect(groupsState.setMemberships).not.toHaveBeenCalled();
  });

  it('Favoritos and custom headers are draggable; Outros is neither draggable nor a group drop target', () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1)];
    mount();
    expect(headerOf('Favoritos')).toHaveAttribute('draggable', 'true');
    expect(headerOf('Clientes')).toHaveAttribute('draggable', 'true');
    expect(headerOf('Outros')).not.toHaveAttribute('draggable', 'true');
    const data = dt();
    drag('dragStart', headerOf('Clientes'), data);
    expect(drag('dragOver', headerOf('Outros'), data)).toBe(true);
    drag('drop', headerOf('Outros'), data);
    expect(groupsState.reorderGroups).not.toHaveBeenCalled();
  });

  it('a group dragged over project rows is ignored', () => {
    groupsState.groups = [fav(), custom('g1', 'Clientes', 1, ['p2'])];
    mount();
    const data = dt();
    drag('dragStart', headerOf('Favoritos'), data);
    expect(drag('dragOver', rowIn('Clientes', 'beta'), data)).toBe(true);
    drag('drop', rowIn('Clientes', 'beta'), data);
    expect(groupsState.reorderGroups).not.toHaveBeenCalled();
    expect(groupsState.setMemberships).not.toHaveBeenCalled();
  });
});
