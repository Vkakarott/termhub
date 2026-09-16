import type { DB } from '../connection.js';
import { newId } from '../../lib/ids.js';
import type { Machine, MachineType } from './types.js';

export interface MachineInput {
  name: string;
  type: MachineType;
  host?: string | null;
  ssh_user?: string | null;
  ssh_port?: number;
}

export class MachinesRepository {
  constructor(private db: DB) {}

  list(): Machine[] {
    return this.db.prepare('SELECT * FROM machines ORDER BY created_at ASC').all() as Machine[];
  }

  findById(id: string): Machine | undefined {
    return this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as Machine | undefined;
  }

  findByType(type: MachineType): Machine[] {
    return this.db.prepare('SELECT * FROM machines WHERE type = ?').all(type) as Machine[];
  }

  create(input: MachineInput): Machine {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO machines (id, name, type, host, ssh_user, ssh_port)
         VALUES (@id, @name, @type, @host, @ssh_user, @ssh_port)`,
      )
      .run({
        id,
        name: input.name,
        type: input.type,
        host: input.host ?? null,
        ssh_user: input.ssh_user ?? null,
        ssh_port: input.ssh_port ?? 22,
      });
    return this.findById(id)!;
  }

  update(id: string, patch: Partial<MachineInput>): Machine | undefined {
    const current = this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE machines SET name = @name, type = @type, host = @host, ssh_user = @ssh_user, ssh_port = @ssh_port
         WHERE id = @id`,
      )
      .run({ ...next, id });
    return this.findById(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM machines WHERE id = ?').run(id).changes > 0;
  }
}
