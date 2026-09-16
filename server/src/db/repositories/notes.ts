import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapNote, type Note } from './types.js';

export class NotesRepository {
  constructor(private db: PrismaClient) {}

  async getByProject(projectId: string): Promise<Note> {
    const n = await this.db.note.findUnique({ where: { projectId } });
    if (n) return mapNote(n);
    return { id: '', project_id: projectId, content: '', updated_at: new Date(0).toISOString() };
  }

  async upsert(projectId: string, content: string): Promise<Note> {
    const n = await this.db.note.upsert({
      where: { projectId },
      create: { id: newId(), projectId, content },
      update: { content },
    });
    return mapNote(n);
  }
}
