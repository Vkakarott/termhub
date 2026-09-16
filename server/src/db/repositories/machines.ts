import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapMachine, type Machine, type MachineType } from './types.js';

export interface MachineInput {
  name: string;
  type: MachineType;
  host?: string | null;
  ssh_user?: string | null;
  ssh_port?: number;
}

export class MachinesRepository {
  constructor(private db: PrismaClient) {}

  async list(): Promise<Machine[]> {
    return (await this.db.machine.findMany({ orderBy: { createdAt: 'asc' } })).map(mapMachine);
  }

  async findById(id: string): Promise<Machine | undefined> {
    const m = await this.db.machine.findUnique({ where: { id } });
    return m ? mapMachine(m) : undefined;
  }

  async findByType(type: MachineType): Promise<Machine[]> {
    return (await this.db.machine.findMany({ where: { type } })).map(mapMachine);
  }

  async create(input: MachineInput): Promise<Machine> {
    const m = await this.db.machine.create({
      data: {
        id: newId(),
        name: input.name,
        type: input.type,
        host: input.host ?? null,
        sshUser: input.ssh_user ?? null,
        sshPort: input.ssh_port ?? 22,
      },
    });
    return mapMachine(m);
  }

  async update(id: string, patch: Partial<MachineInput>): Promise<Machine | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    const m = await this.db.machine.update({
      where: { id },
      data: { name: next.name, type: next.type, host: next.host ?? null, sshUser: next.ssh_user ?? null, sshPort: next.ssh_port ?? 22 },
    });
    return mapMachine(m);
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.machine.deleteMany({ where: { id } });
    return r.count > 0;
  }
}
