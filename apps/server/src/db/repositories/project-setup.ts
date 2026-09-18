import type { PrismaClient } from '../prisma.js';
import { normalizeSetup, SETUP_VERSION, type ProjectSetupData } from '../../setup/schema.js';

export interface ProjectSetup {
  project_id: string;
  version: number;
  data: ProjectSetupData;
  updated_at: string | null;
}

export class ProjectSetupRepository {
  constructor(private db: PrismaClient) {}

  async get(projectId: string): Promise<ProjectSetup> {
    const row = await this.db.projectSetup.findUnique({ where: { projectId } });
    return {
      project_id: projectId,
      version: SETUP_VERSION,
      data: normalizeSetup(row?.data, row?.version ?? SETUP_VERSION),
      updated_at: row?.updatedAt.toISOString() ?? null,
    };
  }

  async save(projectId: string, data: ProjectSetupData): Promise<ProjectSetup> {
    const row = await this.db.projectSetup.upsert({
      where: { projectId },
      create: { projectId, version: SETUP_VERSION, data: data as object },
      update: { version: SETUP_VERSION, data: data as object },
    });
    return { project_id: projectId, version: row.version, data: normalizeSetup(row.data, row.version), updated_at: row.updatedAt.toISOString() };
  }

  /** Projetos com sync automático de tickets configurado. */
  async listWithAutoSync(): Promise<{ project_id: string; data: ProjectSetupData }[]> {
    const rows = await this.db.projectSetup.findMany();
    return rows
      .map((r) => ({ project_id: r.projectId, data: normalizeSetup(r.data, r.version) }))
      .filter((r) => r.data.tickets && r.data.tickets.sync_minutes > 0);
  }
}
