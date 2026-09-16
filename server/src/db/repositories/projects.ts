import type { DB } from '../connection.js';
import { newId } from '../../lib/ids.js';
import type { Project, ProjectStatus } from './types.js';

export interface ProjectInput {
  machine_id: string;
  name: string;
  cwd: string;
  status?: ProjectStatus;
  description?: string | null;
}

export class ProjectsRepository {
  constructor(private db: DB) {}

  list(filter?: { machine_id?: string; status?: ProjectStatus }): Project[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter?.machine_id) {
      where.push('machine_id = @machine_id');
      params.machine_id = filter.machine_id;
    }
    if (filter?.status) {
      where.push('status = @status');
      params.status = filter.status;
    }
    const sql = `SELECT * FROM projects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name COLLATE NOCASE ASC`;
    return this.db.prepare(sql).all(params) as Project[];
  }

  findById(id: string): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
  }

  create(input: ProjectInput): Project {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO projects (id, machine_id, name, cwd, status, description)
         VALUES (@id, @machine_id, @name, @cwd, @status, @description)`,
      )
      .run({
        id,
        machine_id: input.machine_id,
        name: input.name,
        cwd: input.cwd,
        status: input.status ?? 'active',
        description: input.description ?? null,
      });
    return this.findById(id)!;
  }

  update(id: string, patch: Partial<Omit<ProjectInput, 'machine_id'>>): Project | undefined {
    const current = this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE projects SET name = @name, cwd = @cwd, status = @status, description = @description WHERE id = @id`,
      )
      .run({ ...next, id });
    return this.findById(id);
  }

  touchTerminal(id: string): void {
    this.db
      .prepare("UPDATE projects SET last_terminal_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }
}
