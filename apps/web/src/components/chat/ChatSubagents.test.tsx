// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatSubagents } from './ChatSubagents';
import type { SubagentView } from '../../lib/types';

afterEach(() => cleanup());

const sub = (over: Partial<SubagentView> & { id: string }): SubagentView => ({
  description: 'Buscar CI',
  subagent_type: null,
  status: 'running',
  started_at: '2026-09-27T00:00:00.000Z',
  ended_at: null,
  ...over,
});

const NOW = new Date('2026-09-27T00:03:00.000Z').getTime();

it('renders the description, the status and how long it has been running', () => {
  render(<ChatSubagents subagents={[sub({ id: 's1' })]} failed={new Set()} onCancel={vi.fn()} now={NOW} />);
  expect(screen.getByText('Buscar CI')).toBeInTheDocument();
  expect(screen.getByText(/rodando/)).toBeInTheDocument();
  expect(screen.getByText(/há 3 min/)).toBeInTheDocument();
});

it('offers Cancelar only on running lines and calls onCancel with the id', () => {
  const onCancel = vi.fn();
  render(
    <ChatSubagents
      subagents={[sub({ id: 's1', description: 'Buscar CI' }), sub({ id: 's2', description: 'Ler logs', status: 'stopping' })]}
      failed={new Set()}
      onCancel={onCancel}
      now={NOW}
    />,
  );
  const button = screen.getByRole('button', { name: 'Cancelar Buscar CI' });
  fireEvent.click(button);
  expect(onCancel).toHaveBeenCalledWith('s1');
  expect(screen.queryByRole('button', { name: /Cancelar Ler logs/ })).toBeNull();
});

it('a stopping line reads "cancelando…" and shows no button', () => {
  render(<ChatSubagents subagents={[sub({ id: 's1', status: 'stopping' })]} failed={new Set()} onCancel={vi.fn()} now={NOW} />);
  expect(screen.getByText(/cancelando…/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
});

it('an id in failed shows "Não foi possível cancelar"', () => {
  render(<ChatSubagents subagents={[sub({ id: 's1' })]} failed={new Set(['s1'])} onCancel={vi.fn()} now={NOW} />);
  expect(screen.getByText('Não foi possível cancelar')).toBeInTheDocument();
});
