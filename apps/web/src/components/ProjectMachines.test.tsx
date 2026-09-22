// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project } from '../lib/types';

const { linkMachine, updateProjectMachine, unlinkMachine } = vi.hoisted(() => ({ linkMachine: vi.fn(), updateProjectMachine: vi.fn(), unlinkMachine: vi.fn() }));
const machines = [{ id: 'm1', name: 'mac' }, { id: 'm2', name: 'jarvis' }] as Machine[];
vi.mock('../lib/data', () => ({
  useData: () => ({
    machines,
    statuses: { m1: 'online', m2: 'offline' },
    machinesOf: (p: Project) => p.machines.map((l) => machines.find((m) => m.id === l.machine_id)!),
    linkMachine,
    updateProjectMachine,
    unlinkMachine,
  }),
}));
vi.mock('./DirectoryBrowser', () => ({ DirectoryBrowser: () => null }));

import { ProjectMachines } from './ProjectMachines';

const project = { id: 'p1', key: 'P1', name: 'p1', machines: [{ machine_id: 'm1', cwd: '/src/p1', position: 0 }] } as Project;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectMachines', () => {
  it('lists the links and offers only unlinked machines to add', () => {
    render(<ProjectMachines project={project} />);
    expect(screen.getByText('mac')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/src/p1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Vincular máquina' }));
    const options = Array.from((screen.getByLabelText('Máquina') as HTMLSelectElement).options).map((o) => o.value).filter(Boolean);
    expect(options).toEqual(['m2']);
  });

  it('links a machine with its directory', async () => {
    linkMachine.mockResolvedValue(undefined);
    render(<ProjectMachines project={project} />);
    fireEvent.click(screen.getByRole('button', { name: 'Vincular máquina' }));
    fireEvent.change(screen.getByLabelText('Máquina'), { target: { value: 'm2' } });
    fireEvent.change(screen.getByLabelText('Diretório'), { target: { value: '/w' } });
    fireEvent.click(screen.getByRole('button', { name: 'Vincular' }));
    await waitFor(() => expect(linkMachine).toHaveBeenCalledWith('p1', { machine_id: 'm2', cwd: '/w', create_dir: true }));
  });

  it('saves an edited directory and unlinks after confirming', async () => {
    updateProjectMachine.mockResolvedValue(undefined);
    // Real unlinkMachine removes the link from project.machines before returning, which unmounts the
    // row in the same render pass as the parent updates. Reproduce that here (instead of just
    // resolving a value) so the notice's lifetime — outliving the row — is actually exercised.
    const setterRef: { current: ((updater: (p: Project) => Project) => void) | null } = { current: null };
    unlinkMachine.mockImplementation(async (_projectId: string, machineId: string) => {
      setterRef.current?.((p) => ({ ...p, machines: p.machines.filter((l) => l.machine_id !== machineId) }));
      return 2;
    });

    function Harness({ initial }: { initial: Project }) {
      const [p, setP] = useState(initial);
      setterRef.current = setP;
      return <ProjectMachines project={p} />;
    }

    render(<Harness initial={project} />);
    fireEvent.change(screen.getByDisplayValue('/src/p1'), { target: { value: '/moved' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(updateProjectMachine).toHaveBeenCalledWith('p1', 'm1', '/moved', false));
    fireEvent.click(screen.getByRole('button', { name: 'Desvincular' })); // the row's link
    fireEvent.click(screen.getAllByRole('button', { name: 'Desvincular' })[1]); // the dialog's confirm
    await waitFor(() => expect(unlinkMachine).toHaveBeenCalledWith('p1', 'm1'));
    expect(screen.queryByDisplayValue('/moved')).not.toBeInTheDocument();
    await screen.findByText('2 tabs fechadas.');
  });

  it("resyncs a row's cwd when the link changes from outside (e.g. saved elsewhere) without remounting the whole section", () => {
    // Without keying LinkRow on the cwd too, its local `useState(link.cwd)` would stay stuck on the
    // stale value here: React only re-reads a `useState` initializer on remount, not on a prop change.
    function Harness({ initial }: { initial: Project }) {
      const [p, setP] = useState(initial);
      return (
        <>
          <ProjectMachines project={p} />
          <button
            onClick={() => setP((x) => ({ ...x, machines: x.machines.map((l) => (l.machine_id === 'm1' ? { ...l, cwd: '/moved-elsewhere' } : l)) }))}
          >
            simulate external update
          </button>
        </>
      );
    }
    render(<Harness initial={project} />);
    expect(screen.getByDisplayValue('/src/p1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'simulate external update' }));
    expect(screen.getByDisplayValue('/moved-elsewhere')).toBeInTheDocument();
  });
});
