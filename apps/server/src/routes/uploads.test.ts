import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import type { Upload } from '../db/repositories/uploads.js';
import { applyErrorHandler } from '../lib/errors.js';
import { uploadRoutes } from './uploads.js';

const listPasteDir = vi.fn();
const deletePasteFile = vi.fn();
vi.mock('../terminal/uploads.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../terminal/uploads.js')>()),
  listPasteDir: (...args: unknown[]) => listPasteDir(...args),
  deletePasteFile: (...args: unknown[]) => deletePasteFile(...args),
}));

const machines = [
  { id: 'm1', name: 'jarvis', owner_id: 'ana', owner_name: 'Ana', type: 'local' },
  { id: 'm2', name: 'mac', owner_id: 'ana', owner_name: 'Ana', type: 'ssh' },
  { id: 'm3', name: 'pi', owner_id: 'ana', owner_name: 'Ana', type: 'agent' },
];
const row = (over: Partial<Upload>): Upload => ({
  id: 'u1', user_id: 'ana', user_name: 'Ana', user_email: 'ana@x.com', machine_id: 'm1', project_id: null, tab_id: null,
  name: 'paste-20260918-100000-abc123-report.pdf', path: '/home/x/.cache/termhub/paste/paste-20260918-100000-abc123-report.pdf',
  mime: 'application/pdf', bytes: 100, created_at: '2026-09-18T10:00:00.000Z', ...over,
});

const deleteMissing = vi.fn(async () => 0);
const deleteByName = vi.fn(async () => true);
let rows: Upload[] = [];

function buildApp() {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { ownerId: null } as never;
  });
  const repos = {
    machines: { list: async () => machines, findById: async (id: string) => machines.find((m) => m.id === id) },
    uploads: { list: async () => rows, deleteMissing, deleteByName },
  } as unknown as Repositories;
  app.register((a) => uploadRoutes(a, repos), { prefix: '/api/uploads' });
  return app;
}

beforeEach(() => {
  listPasteDir.mockReset();
  deletePasteFile.mockReset();
  deleteMissing.mockClear();
  deleteByName.mockClear();
  rows = [];
});

describe('GET /api/uploads', () => {
  it('joins what is on disk with who sent it, and forgets rows whose files are gone', async () => {
    rows = [row({}), row({ id: 'u2', name: 'paste-20260918-090000-000000-gone.png', mime: 'image/png' })];
    listPasteDir.mockImplementation(async (m: { id: string }) =>
      m.id === 'm1'
        ? { ok: true, files: [{ name: 'paste-20260918-100000-abc123-report.pdf', bytes: 120, modified_at: '2026-09-18T10:00:01.000Z' }, { name: 'paste-20260917-000000-ffffff-old.png', bytes: 5, modified_at: '2026-09-17T00:00:00.000Z' }] }
        : { ok: true, files: [] },
    );
    const res = await buildApp().inject({ method: 'GET', url: '/api/uploads' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.machines.map((m: { id: string; ok: boolean }) => [m.id, m.ok])).toEqual([['m1', true], ['m2', true], ['m3', true]]);
    expect(body.machines[0]).toMatchObject({ owner_id: 'ana', owner_name: 'Ana' });
    expect(body.files).toHaveLength(2);
    const attributed = body.files.find((f: { name: string }) => f.name.endsWith('report.pdf'));
    expect(attributed).toMatchObject({ machine_id: 'm1', bytes: 120, on_disk: true, upload: { user_name: 'Ana', mime: 'application/pdf' } });
    const orphan = body.files.find((f: { name: string }) => f.name.endsWith('old.png'));
    expect(orphan).toMatchObject({ on_disk: true, upload: null });
    // the row for gone.png is pruned: only report.pdf is still present on m1
    expect(deleteMissing).toHaveBeenCalledWith('m1', ['paste-20260918-100000-abc123-report.pdf', 'paste-20260917-000000-ffffff-old.png']);
  });

  it('keeps the recorded files of an unreachable machine, flagged', async () => {
    rows = [row({ machine_id: 'm2' })];
    listPasteDir.mockImplementation(async (m: { id: string }) => (m.id === 'm2' ? { ok: false, error: 'Falha ao conectar via SSH' } : { ok: true, files: [] }));
    const body = (await buildApp().inject({ method: 'GET', url: '/api/uploads' })).json();
    expect(body.machines.find((m: { id: string }) => m.id === 'm2')).toMatchObject({ ok: false, error: 'Falha ao conectar via SSH' });
    expect(body.files).toEqual([expect.objectContaining({ machine_id: 'm2', on_disk: false, bytes: 100 })]);
    expect(deleteMissing).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/uploads/:machineId/:name', () => {
  it('removes the file on the machine and its row', async () => {
    deletePasteFile.mockResolvedValueOnce(true);
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/uploads/m1/paste-20260918-100000-abc123-report.pdf' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, existed: true });
    expect(deletePasteFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }), 'paste-20260918-100000-abc123-report.pdf');
    expect(deleteByName).toHaveBeenCalledWith('m1', 'paste-20260918-100000-abc123-report.pdf');
  });

  it('refuses names that are not paste files (nothing reaches the shell)', async () => {
    for (const name of ['..%2F..%2Fetc%2Fpasswd', 'notes.txt', 'paste-a%20b', 'paste-x%3Brm']) {
      const res = await buildApp().inject({ method: 'DELETE', url: `/api/uploads/m1/${name}` });
      expect(res.statusCode, name).toBe(400);
    }
    expect(deletePasteFile).not.toHaveBeenCalled();
  });

  it('answers 409 for an agent machine before touching it', async () => {
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/uploads/m3/paste-20260918-100000-abc123-report.pdf' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Remoção de arquivos ainda não disponível em máquinas com agente');
    expect(deletePasteFile).not.toHaveBeenCalled();
    expect(deleteByName).not.toHaveBeenCalled();
  });

  it('answers 502 with the machine error when the rm fails', async () => {
    deletePasteFile.mockRejectedValueOnce(new Error('Falha ao conectar via SSH'));
    const res = await buildApp().inject({ method: 'DELETE', url: '/api/uploads/m2/paste-20260918-100000-abc123-report.pdf' });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('Falha ao conectar via SSH');
    expect(deleteByName).not.toHaveBeenCalled();
  });
});
