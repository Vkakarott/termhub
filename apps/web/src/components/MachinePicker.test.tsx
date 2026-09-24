// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Machine, Project } from '../lib/types';
import { MachinePicker } from './MachinePicker';

const project = {
  id: 'p1',
  machines: [
    { machine_id: 'm1', cwd: '/src/a', position: 0 },
    { machine_id: 'm2', cwd: '/src/b', position: 1 },
  ],
} as Project;
const machines = [{ id: 'm1', name: 'mac', subtitle: 'MacBook do escritório' }, { id: 'm2', name: 'jarvis', subtitle: null }] as Machine[];

afterEach(cleanup);

describe('MachinePicker', () => {
  it('names each machine "nome — subtítulo" when opening a terminal, and picks by id', () => {
    const onPick = vi.fn();
    render(<MachinePicker open project={project} machines={machines} onPick={onPick} onClose={() => {}} />);
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent?.includes('/src/'));
    expect(buttons.map((b) => b.textContent)).toEqual(['mac — MacBook do escritório/src/a', 'jarvis/src/b']);
    fireEvent.click(buttons[0]);
    expect(onPick).toHaveBeenCalledWith('m1');
  });
});
