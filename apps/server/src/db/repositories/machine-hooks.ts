import type { PrismaClient } from '../prisma.js';

export interface MachineHook {
  machine_id: string;
  installed_at: string;
}

/** Hook install per machine: only the sha256 of the token the machine's hook script posts with. */
export class MachineHooksRepository {
  constructor(private db: PrismaClient) {}

  async findByMachine(machineId: string): Promise<MachineHook | undefined> {
    const h = await this.db.machineHook.findUnique({ where: { machineId } });
    return h ? { machine_id: h.machineId, installed_at: h.installedAt.toISOString() } : undefined;
  }

  /** Machine id for a token hash, or undefined (unknown / revoked). */
  async machineIdForTokenHash(tokenHash: string): Promise<string | undefined> {
    const h = await this.db.machineHook.findUnique({ where: { tokenHash }, select: { machineId: true } });
    return h?.machineId;
  }

  /** Creates or rotates the machine's hook token (the old one stops working at once). */
  async upsert(machineId: string, tokenHash: string): Promise<MachineHook> {
    const h = await this.db.machineHook.upsert({
      where: { machineId },
      create: { machineId, tokenHash },
      update: { tokenHash, installedAt: new Date() },
    });
    return { machine_id: h.machineId, installed_at: h.installedAt.toISOString() };
  }

  async delete(machineId: string): Promise<boolean> {
    const r = await this.db.machineHook.deleteMany({ where: { machineId } });
    return r.count > 0;
  }
}
