import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

/** Attribution row for a file pasted/dropped on a terminal (see prisma model Upload). */
export interface Upload {
  id: string;
  user_id: string | null;
  user_name: string | null;
  user_email: string | null;
  machine_id: string;
  project_id: string | null;
  tab_id: string | null;
  name: string;
  path: string;
  mime: string;
  bytes: number;
  created_at: string;
}

export interface UploadInput {
  user_id: string | null;
  machine_id: string;
  project_id?: string | null;
  tab_id?: string | null;
  name: string;
  path: string;
  mime: string;
  bytes: number;
}

const withUser = { user: { select: { name: true, email: true } } } as const;

function map(u: {
  id: string; userId: string | null; machineId: string; projectId: string | null; tabId: string | null; name: string; path: string; mime: string; bytes: number; createdAt: Date;
  user?: { name: string; email: string } | null;
}): Upload {
  return {
    id: u.id, user_id: u.userId, user_name: u.user?.name ?? null, user_email: u.user?.email ?? null, machine_id: u.machineId, project_id: u.projectId,
    tab_id: u.tabId, name: u.name, path: u.path, mime: u.mime, bytes: u.bytes, created_at: u.createdAt.toISOString(),
  };
}

export class UploadsRepository {
  constructor(private db: PrismaClient) {}

  async create(input: UploadInput): Promise<Upload> {
    const u = await this.db.upload.upsert({
      where: { machineId_name: { machineId: input.machine_id, name: input.name } },
      create: {
        id: newId(), userId: input.user_id, machineId: input.machine_id, projectId: input.project_id ?? null, tabId: input.tab_id ?? null,
        name: input.name, path: input.path, mime: input.mime, bytes: input.bytes,
      },
      update: { userId: input.user_id, projectId: input.project_id ?? null, tabId: input.tab_id ?? null, path: input.path, mime: input.mime, bytes: input.bytes },
      include: withUser,
    });
    return map(u);
  }

  async list(): Promise<Upload[]> {
    return (await this.db.upload.findMany({ include: withUser, orderBy: { createdAt: 'desc' } })).map(map);
  }

  async deleteByName(machineId: string, name: string): Promise<boolean> {
    return (await this.db.upload.deleteMany({ where: { machineId, name } })).count > 0;
  }

  /** Drops rows whose files are gone from a machine (after a fresh directory listing). */
  async deleteMissing(machineId: string, presentNames: string[]): Promise<number> {
    return (await this.db.upload.deleteMany({ where: { machineId, name: { notIn: presentNames } } })).count;
  }
}
