import type { DB } from '../connection.js';
import { newId } from '../../lib/ids.js';
import type { Tab } from './types.js';

export class TabsRepository {
  constructor(private db: DB) {}

  listByProject(projectId: string): Tab[] {
    return this.db
      .prepare('SELECT * FROM tabs WHERE project_id = ? ORDER BY position ASC, created_at ASC')
      .all(projectId) as Tab[];
  }

  listAll(): Tab[] {
    return this.db.prepare('SELECT * FROM tabs').all() as Tab[];
  }

  findById(id: string): Tab | undefined {
    return this.db.prepare('SELECT * FROM tabs WHERE id = ?').get(id) as Tab | undefined;
  }

  create(projectId: string, name: string): Tab {
    const id = newId();
    const tmuxSession = `termhub-${projectId}-${id}`;
    const pos = (
      this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM tabs WHERE project_id = ?').get(projectId) as {
        p: number;
      }
    ).p;
    this.db
      .prepare('INSERT INTO tabs (id, project_id, name, tmux_session, position) VALUES (?, ?, ?, ?, ?)')
      .run(id, projectId, name, tmuxSession, pos);
    return this.findById(id)!;
  }

  rename(id: string, name: string): Tab | undefined {
    this.db.prepare('UPDATE tabs SET name = ? WHERE id = ?').run(name, id);
    return this.findById(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM tabs WHERE id = ?').run(id).changes > 0;
  }
}
