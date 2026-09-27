// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgressResponse, Tab } from '../lib/types';

const progressMock = vi.fn();
const live: Record<string, Tab | undefined> = {};
vi.mock('../lib/api', () => ({ api: { progress: (...a: unknown[]) => progressMock(...a) } }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ tabState: (id: string) => live[id] }) }));

import { PROGRESS_REFRESH_MS, ProgressPanel } from './ProgressPanel';

const response = (): ProgressResponse => ({
  generated_at: '2026-09-27T12:00:00.000Z',
  epics: [{
    id: 'e1', ref: 'TER-182', title: 'Visão gerencial', project: { id: 'p1', key: 'TER', name: 'termhub' },
    units: { done: 3, total: 6, backlog_total: 1 }, percent: 50,
    estimate: { kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 2 },
    cards_without_estimate: 1, agents: { working: 1, needs_you: 0, idle: 0 },
    cards: [{
      id: 'c1', ref: 'TER-183', title: 'Painel de progresso', type: 'story', status: 'doing', column_name: 'Fazendo',
      units: { done: 3, total: 5 }, percent: 60, started_at: null, done_at: null, active_seconds: 1800,
      estimate: { kind: 'range', low_s: 1200, high_s: 2700, basis: 'agent_time', samples: 3 },
      agents: [{ tab_id: 't1', tab_name: 'spec', machine_name: 'jarvis', subtask_ref: null, state: 'working', state_at: '2026-09-27T11:50:00.000Z', needs_you: false, activity: 'coding', activity_verb: 'Coding', rate_limited: false }],
    }],
  }],
});

function mount() {
  render(<MemoryRouter><ProgressPanel projectId="p1" /></MemoryRouter>);
}

beforeEach(() => {
  progressMock.mockReset();
  progressMock.mockResolvedValue(response());
  for (const k of Object.keys(live)) delete live[k];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ProgressPanel', () => {
  it('shows the epic and card progress, estimate and agent state', async () => {
    mount();
    expect(await screen.findByText('Visão gerencial')).toBeInTheDocument();
    expect(progressMock).toHaveBeenCalledWith({ project_id: 'p1', scope: 'active' });
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText('3/6 · backlog: 1')).toBeInTheDocument();
    expect(screen.getAllByText('~20–45 min de trabalho')).toHaveLength(2);
    expect(screen.getByText('1 cards sem estimativa')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /TER-183/ })).toHaveAttribute('href', '/project/TER-183');
    expect(screen.getByRole('link', { name: /spec.*trabalhando/ })).toHaveAttribute('href', '/projects/p1?tab=t1');
  });

  it('overlays the live monitor state and lists who is waiting for the user', async () => {
    live.t1 = { id: 't1', state: 'waiting_input', state_at: '2026-09-27T12:01:00.000Z', activity: null, activity_verb: null, rate_limited_at: null } as Tab;
    mount();
    expect(await screen.findByText('1 agente esperando você')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /spec.*esperando você/ })[0]).toHaveAttribute('href', '/projects/p1?tab=t1');
  });

  it('switches to every epic', async () => {
    mount();
    await screen.findByText('Visão gerencial');
    fireEvent.click(screen.getByRole('button', { name: 'Todos' }));
    await waitFor(() => expect(progressMock).toHaveBeenLastCalledWith({ project_id: 'p1', scope: 'all' }));
  });

  it('says so when nothing is running', async () => {
    progressMock.mockResolvedValue({ generated_at: '', epics: [] });
    mount();
    expect(await screen.findByText('Nenhum épico em andamento')).toBeInTheDocument();
  });

  it('refreshes every 15 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    await screen.findByText('Visão gerencial');
    await act(async () => {
      vi.advanceTimersByTime(PROGRESS_REFRESH_MS);
    });
    expect(progressMock).toHaveBeenCalledTimes(2);
  });

  it('shows the error when loading fails', async () => {
    progressMock.mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText('Não foi possível carregar o progresso.')).toBeInTheDocument();
  });
});
