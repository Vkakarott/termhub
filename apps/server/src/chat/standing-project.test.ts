import { describe, expect, it, vi } from 'vitest';
import { standingProjectOf } from './standing-project.js';

const tab = { id: 't1', project_id: 'p1' };

const repos = {
  projects: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('p1') ? [{ id: 'p1' }] : [])) },
  tasks: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('k1') ? [{ id: 'k1', project_id: 'p1' }] : [])) },
  tabs: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('t1') ? [tab] : [])) },
} as never;

describe('standingProjectOf', () => {
  it.each(['open_tab', 'start_agent'] as const)('%s → its own project', async (kind) => {
    expect(await standingProjectOf(repos, 'u1', kind, kind, { project_id: 'p1' })).toEqual({ projectId: 'p1' });
  });

  it.each(['open_tab', 'start_agent'] as const)('%s on a foreign project → null', async (kind) => {
    expect(await standingProjectOf(repos, 'u1', kind, kind, { project_id: 'p9' })).toBeNull();
  });

  it.each(['open_tab', 'start_agent'] as const)('%s with a missing project_id → null', async (kind) => {
    expect(await standingProjectOf(repos, 'u1', kind, kind, {})).toBeNull();
  });

  it.each(['close_tab', 'terminal'] as const)('%s → the tab\'s own project and the tab itself', async (kind) => {
    expect(await standingProjectOf(repos, 'u1', kind, 'send_input', { tab_id: 't1' })).toEqual({ projectId: 'p1', tab });
  });

  it.each(['close_tab', 'terminal'] as const)('%s on a foreign or missing tab → null', async (kind) => {
    expect(await standingProjectOf(repos, 'u1', kind, 'send_input', { tab_id: 't9' })).toBeNull();
    expect(await standingProjectOf(repos, 'u2', kind, 'send_input', { tab_id: 't1' })).toBeNull();
    expect(await standingProjectOf(repos, 'u1', kind, 'send_input', {})).toBeNull();
  });

  it('board delegates to boardProjectOf', async () => {
    expect(await standingProjectOf(repos, 'u1', 'board', 'create_task', { project_id: 'p1' })).toEqual({ projectId: 'p1' });
    expect(await standingProjectOf(repos, 'u1', 'board', 'move_task', { task_id: 'k1' })).toEqual({ projectId: 'p1' });
    expect(await standingProjectOf(repos, 'u1', 'board', 'move_task', { task_id: 'k9' })).toBeNull();
    expect(await standingProjectOf(repos, 'u1', 'board', 'delete_task', { task_id: 'k1' })).toBeNull();
  });
});
