import { describe, expect, it, vi } from 'vitest';
import { boardProjectOf } from './board-project.js';

const repos = {
  projects: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('p1') ? [{ id: 'p1' }] : [])) },
  tasks: { findByIdsForOwner: vi.fn(async (ids: string[], owner: string) => (owner === 'u1' && ids.includes('k1') ? [{ id: 'k1', project_id: 'p1' }] : [])) },
} as never;

describe('boardProjectOf', () => {
  it('create_task → its own project', async () => expect(await boardProjectOf(repos, 'u1', 'create_task', { project_id: 'p1' })).toBe('p1'));
  it('create_task on a foreign project → null', async () => expect(await boardProjectOf(repos, 'u1', 'create_task', { project_id: 'p9' })).toBeNull());
  it.each(['add_subtasks', 'update_task', 'move_task'])('%s → the card project', async (t) => expect(await boardProjectOf(repos, 'u1', t, { task_id: 'k1' })).toBe('p1'));
  it('a foreign or missing card → null', async () => {
    expect(await boardProjectOf(repos, 'u1', 'move_task', { task_id: 'k9' })).toBeNull();
    expect(await boardProjectOf(repos, 'u2', 'move_task', { task_id: 'k1' })).toBeNull();
  });
  it('malformed ids and other tools → null, without reading', async () => {
    expect(await boardProjectOf(repos, 'u1', 'move_task', { task_id: 42 })).toBeNull();
    expect(await boardProjectOf(repos, 'u1', 'delete_task', { task_id: 'k1' })).toBeNull();
  });
});
