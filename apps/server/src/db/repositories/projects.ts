import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapProject, type Project, type ProjectStatus } from './types.js';

export interface ProjectInput {
  machine_id: string;
  name: string;
  cwd: string;
  status?: ProjectStatus;
  description?: string | null;
}

export class ProjectsRepository {
  constructor(private db: PrismaClient) {}

  /** `owner`: restrict to projects whose machine belongs to that user (undefined/null = no filter). */
  async list(filter?: { machine_id?: string; status?: ProjectStatus; owner?: string | null }): Promise<Project[]> {
    const rows = await this.db.project.findMany({
      where: {
        ...(filter?.machine_id ? { machineId: filter.machine_id } : {}),
        ...(filter?.status ? { status: filter.status } : {}),
        ...(filter?.owner ? { machine: { ownerId: filter.owner } } : {}),
      },
      orderBy: { name: 'asc' },
    });
    return rows.map(mapProject);
  }

  async findById(id: string): Promise<Project | undefined> {
    const p = await this.db.project.findUnique({ where: { id } });
    return p ? mapProject(p) : undefined;
  }

  /**
   * Batched by id, one query regardless of how many ids are asked for, filtered to one owner's
   * projects through their machine — never "no filter": a caller that resolves names for one
   * person's screen (e.g. the chat action trail) must not be able to pass `null` and see everyone's.
   * Another owner's project id is simply absent from the result, like a row that does not exist. The
   * owner filter is a join condition, not a reason to query per row.
   */
  async findByIdsForOwner(ids: string[], ownerId: string): Promise<Project[]> {
    if (ids.length === 0) return [];
    return (await this.db.project.findMany({ where: { id: { in: ids }, machine: { ownerId } } })).map(mapProject);
  }

  async create(input: ProjectInput): Promise<Project> {
    const p = await this.db.project.create({
      data: {
        id: newId(),
        machineId: input.machine_id,
        name: input.name,
        cwd: input.cwd,
        status: input.status ?? 'active',
        description: input.description ?? null,
      },
    });
    return mapProject(p);
  }

  async update(id: string, patch: Partial<Omit<ProjectInput, 'machine_id'>>): Promise<Project | undefined> {
    const current = await this.findById(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    const p = await this.db.project.update({
      where: { id },
      data: { name: next.name, cwd: next.cwd, status: next.status, description: next.description ?? null },
    });
    return mapProject(p);
  }

  async touchTerminal(id: string): Promise<void> {
    await this.db.project.updateMany({ where: { id }, data: { lastTerminalAt: new Date() } });
  }

  async delete(id: string): Promise<boolean> {
    const r = await this.db.project.deleteMany({ where: { id } });
    return r.count > 0;
  }
}
