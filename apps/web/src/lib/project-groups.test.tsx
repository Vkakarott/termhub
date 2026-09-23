// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), rename: vi.fn(), remove: vi.fn(), reorder: vi.fn(), setMemberships: vi.fn(),
}));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), api: { projectGroups: api } }));
// A mutable holder so a test can change viewAs (by value or by reference) between renders.
const auth = vi.hoisted(() => ({ viewAs: { kind: 'self' } as unknown }));
vi.mock('./auth', () => ({ useAuth: () => ({ viewAs: auth.viewAs }) }));

import { ProjectGroupsProvider, useProjectGroups } from './project-groups';

const fav = { id: 'fav', name: 'Favoritos', kind: 'favorites' as const, position: 0, project_ids: ['a'] };
const g1 = { id: 'g1', name: 'Clientes', kind: 'custom' as const, position: 1, project_ids: [] as string[] };
let state: ReturnType<typeof useProjectGroups>;
function Probe() {
  state = useProjectGroups();
  return <p data-testid="out">{state.groups.map((g) => `${g.name}:${g.project_ids.join(',')}`).join('|')}{state.error ? ` !${state.error}` : ''}</p>;
}
const mount = async () => {
  api.list.mockResolvedValue({ groups: [fav, g1] });
  render(<ProjectGroupsProvider><Probe /></ProjectGroupsProvider>);
  await screen.findByText('Favoritos:a|Clientes:');
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.viewAs = { kind: 'self' };
});

describe('ProjectGroupsProvider', () => {
  it('toggleFavorite adds then removes, optimistically', async () => {
    await mount();
    let resolve!: (v: unknown) => void;
    api.setMemberships.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    act(() => { void state.toggleFavorite('b'); });
    expect(screen.getByTestId('out')).toHaveTextContent('Favoritos:a,b|Clientes:');
    expect(api.setMemberships).toHaveBeenCalledWith([{ id: 'fav', project_ids: ['a', 'b'] }]);
    await act(async () => resolve({ groups: [{ ...fav, project_ids: ['a', 'b'] }, g1] }));
    expect(state.isFavorite('b')).toBe(true);
  });

  it('rolls back to the exact previous state when a write fails', async () => {
    await mount();
    api.setMemberships.mockRejectedValueOnce(new Error('boom'));
    await act(async () => { await state.setMemberships([{ ...fav, project_ids: [] }, { ...g1, project_ids: ['a'] }], [{ id: 'fav', project_ids: [] }, { id: 'g1', project_ids: ['a'] }]); });
    expect(screen.getByTestId('out')).toHaveTextContent('Favoritos:a|Clientes:');
    expect(screen.getByTestId('out')).toHaveTextContent('!');
  });

  it('create, rename, delete and reorder hit the API and update the list', async () => {
    await mount();
    api.create.mockResolvedValueOnce({ group: { id: 'g2', name: 'Novo grupo', kind: 'custom', position: 2, project_ids: [] } });
    await act(async () => { await state.createGroup('Novo grupo'); });
    expect(screen.getByTestId('out')).toHaveTextContent('Novo grupo:');
    api.rename.mockResolvedValueOnce({ group: { id: 'g2', name: 'Outro nome', kind: 'custom', position: 2, project_ids: [] } });
    await act(async () => { await state.renameGroup('g2', 'Outro nome'); });
    expect(screen.getByTestId('out')).toHaveTextContent('Outro nome:');
    api.remove.mockResolvedValueOnce(undefined);
    await act(async () => { await state.deleteGroup('g2'); });
    expect(screen.getByTestId('out')).not.toHaveTextContent('Outro nome');
    api.reorder.mockResolvedValueOnce({ groups: [{ ...g1, position: 0 }, { ...fav, position: 1 }] });
    await act(async () => { await state.reorderGroups('g1', 0); });
    expect(api.reorder).toHaveBeenCalledWith(['g1', 'fav']);
    expect(screen.getByTestId('out')).toHaveTextContent('Clientes:|Favoritos:a');
  });

  it('keeps a later write that already succeeded when an earlier one then fails', async () => {
    await mount();

    // A: adds 'x' to Favoritos, but its request never settles until we reject it below.
    let rejectA!: (e: unknown) => void;
    const pendingA = new Promise((_resolve, reject) => (rejectA = reject));
    api.setMemberships.mockReturnValueOnce(pendingA);
    const nextA = [{ ...fav, project_ids: ['a', 'x'] }, g1];
    let writeA!: Promise<void>;
    act(() => { writeA = state.setMemberships(nextA, [{ id: 'fav', project_ids: ['a', 'x'] }]); });
    expect(screen.getByTestId('out')).toHaveTextContent('Favoritos:a,x|Clientes:');

    // B: while A is still in flight, adds 'y' to Clientes, and its own request succeeds right away.
    const fromServerB = [fav, { ...g1, project_ids: ['y'] }];
    api.setMemberships.mockResolvedValueOnce({ groups: fromServerB });
    await act(async () => { await state.setMemberships([fav, { ...g1, project_ids: ['y'] }], [{ id: 'g1', project_ids: ['y'] }]); });
    expect(screen.getByTestId('out')).toHaveTextContent('Favoritos:a|Clientes:y');

    // A now rejects. It must not roll back over B's already-confirmed state; it re-syncs from the
    // server instead, which by then reflects only B's write.
    api.list.mockResolvedValueOnce({ groups: fromServerB });
    await act(async () => {
      rejectA(new Error('boom'));
      await writeA;
    });
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('Favoritos:a|Clientes:y'));
    expect(screen.getByTestId('out')).toHaveTextContent('!');
  });

  it('reloads when viewAs changes by value, but not for an equal-value new object', async () => {
    api.list.mockResolvedValue({ groups: [fav, g1] });
    const { rerender } = render(<ProjectGroupsProvider><Probe /></ProjectGroupsProvider>);
    await screen.findByText('Favoritos:a|Clientes:');
    expect(api.list).toHaveBeenCalledTimes(1);

    // Same logical scope, a freshly built object: must not reload.
    auth.viewAs = { kind: 'self' };
    rerender(<ProjectGroupsProvider><Probe /></ProjectGroupsProvider>);
    await act(async () => {});
    expect(api.list).toHaveBeenCalledTimes(1);

    // A real scope change: must reload.
    auth.viewAs = { kind: 'all' };
    rerender(<ProjectGroupsProvider><Probe /></ProjectGroupsProvider>);
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  });
});
