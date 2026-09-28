import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { Repositories } from '../db/repositories/index.js';
import { NoteTooLargeError } from '../db/repositories/notes.js';
import type { Note } from '../db/repositories/types.js';
import { applyErrorHandler } from '../lib/errors.js';
import { noteRoutes } from './notes.js';

const project = { id: 'p1', key: 'P1', owner_id: 'u1' };
const note = (over: Partial<Note> = {}): Note => ({ id: 'n1', project_id: 'p1', content: 'texto', updated_at: '2026-09-27T03:00:00.000Z', ...over });

/** Routes over stubbed repositories and a fixed request scope (u1, "self"). */
function buildApp(saveMerged = vi.fn(async () => note())) {
  const app = Fastify();
  applyErrorHandler(app);
  app.addHook('preHandler', async (request) => {
    request.scope = { user: { id: 'u1' } as never, viewAs: { kind: 'self' }, ownerId: 'u1', createAs: 'u1' };
    request.user = { id: 'u1' } as never;
  });
  const notesRepo = {
    getByProject: vi.fn(async () => note()),
    upsert: vi.fn(async (_id: string, content: string) => note({ content })),
    saveMerged,
  };
  const repos = {
    notes: notesRepo,
    projects: { findById: vi.fn(async (id: string) => (id === 'p1' ? project : undefined)) },
  } as unknown as Repositories;
  app.register((a) => noteRoutes(a, repos), { prefix: '/projects' });
  return { app, notesRepo };
}

describe('note routes', () => {
  it('GET returns the project note', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/projects/p1/note' });
    expect(r.statusCode).toBe(200);
    expect(r.json().note.content).toBe('texto');
  });

  it('PUT without base_updated_at behaves as a plain upsert (old clients): saveMerged gets base=null', async () => {
    const saveMerged = vi.fn(async () => note({ content: 'novo texto' }));
    const { app } = buildApp(saveMerged);
    const r = await app.inject({ method: 'PUT', url: '/projects/p1/note', payload: { content: 'novo texto' } });
    expect(r.statusCode).toBe(200);
    expect(saveMerged).toHaveBeenCalledWith('p1', 'novo texto', null);
  });

  it('PUT with base_updated_at calls saveMerged and returns the merged note', async () => {
    const saveMerged = vi.fn(async () => note({ content: 'mesclado' }));
    const { app } = buildApp(saveMerged);
    const r = await app.inject({
      method: 'PUT',
      url: '/projects/p1/note',
      payload: { content: 'meu texto', base_updated_at: '2026-09-27T03:00:00.000Z' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().note.content).toBe('mesclado');
    expect(saveMerged).toHaveBeenCalledWith('p1', 'meu texto', new Date('2026-09-27T03:00:00.000Z'));
  });

  it('a bad base_updated_at is a 400', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'PUT', url: '/projects/p1/note', payload: { content: 'x', base_updated_at: 'not-a-date' } });
    expect(r.statusCode).toBe(400);
  });

  it('a note over NOTE_MAX after merging is a 413', async () => {
    const saveMerged = vi.fn(async () => {
      throw new NoteTooLargeError();
    });
    const { app } = buildApp(saveMerged);
    const r = await app.inject({
      method: 'PUT',
      url: '/projects/p1/note',
      payload: { content: 'x', base_updated_at: '2026-09-27T03:00:00.000Z' },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBe('A anotação passou do limite de 200 000 caracteres');
  });

  it('another owner\'s project is a 404', async () => {
    const { app } = buildApp();
    const r = await app.inject({ method: 'GET', url: '/projects/p9/note' });
    expect(r.statusCode).toBe(404);
  });
});
