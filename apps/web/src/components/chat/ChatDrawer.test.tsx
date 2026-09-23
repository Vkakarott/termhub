// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatDrawer } from './ChatDrawer';
import { useProjectChat } from '../../lib/project-chat';

vi.mock('./ChatPanel', () => ({ ChatPanel: ({ projectId }: { projectId: string }) => <div>painel {projectId}</div> }));
vi.mock('../../lib/data', () => ({ useData: () => ({ projects: [{ id: 'p1', name: 'Popingo', key: 'POP' }, { id: 'p2', name: 'Outro', key: 'OUT' }] }) }));
const state = vi.hoisted(() => ({ openProjectId: 'p1' as string | null, close: vi.fn() }));
vi.mock('../../lib/project-chat', () => ({ useProjectChat: () => ({ ...state, toggle: vi.fn(), status: () => ({ busy: false, pending: 0 }) }) }));

afterEach(cleanup);

it('shows the open project chat with its name', () => {
  render(<MemoryRouter><ChatDrawer /></MemoryRouter>);
  expect(screen.getByRole('dialog', { name: 'Chat · Popingo' })).toBeTruthy();
  expect(screen.getByText('painel p1')).toBeTruthy();
});

it('keys the panel by project, so switching projects remounts it', () => {
  const { rerender } = render(<MemoryRouter><ChatDrawer /></MemoryRouter>);
  state.openProjectId = 'p2';
  rerender(<MemoryRouter><ChatDrawer /></MemoryRouter>);
  expect(screen.getByText('painel p2')).toBeTruthy();
  state.openProjectId = 'p1';
});

it('Escape and × close it', () => {
  render(<MemoryRouter><ChatDrawer /></MemoryRouter>);
  act(() => void fireEvent.keyDown(window, { key: 'Escape' }));
  expect(state.close).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Fechar chat' }));
  expect(state.close).toHaveBeenCalledTimes(2);
});

it('renders nothing when closed', () => {
  state.openProjectId = null;
  const { container } = render(<MemoryRouter><ChatDrawer /></MemoryRouter>);
  expect(container.innerHTML).toBe('');
  state.openProjectId = 'p1';
});
