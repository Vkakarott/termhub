import { describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn() }));

import { spawn } from 'node:child_process';
import type { Machine } from '../db/repositories/types.js';
import { listPasteDir } from './uploads.js';

const agent = { id: 'm1', type: 'agent', name: 'pi', capabilities: [], os: null } as unknown as Machine;

describe('listPasteDir', () => {
  it('reports an agent machine as not listable instead of shelling out', async () => {
    const r = await listPasteDir(agent);
    expect(r).toEqual({ ok: false, error: 'Listagem de arquivos ainda não disponível em máquinas com agente' });
    expect(spawn).not.toHaveBeenCalled();
  });
});
