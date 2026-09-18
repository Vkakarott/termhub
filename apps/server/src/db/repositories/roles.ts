import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

export interface Role {
  id: string;
  name: string;
  label: string;
  description: string | null;
  is_system: boolean;
  is_admin: boolean;
  created_at: string;
  /** number of users with this role (list only) */
  users?: number;
}

export interface PermissionGrant {
  resource: string;
  action: string;
}

/** Fixed ids for the system roles so migrations, seeds and code agree. */
export const SYSTEM_ROLE_IDS = { admin: 'role_admin', manager: 'role_manager', authenticated: 'role_authenticated' } as const;

const map = (r: { id: string; name: string; label: string; description: string | null; isSystem: boolean; isAdmin: boolean; createdAt: Date }, users?: number): Role => ({
  id: r.id, name: r.name, label: r.label, description: r.description, is_system: r.isSystem, is_admin: r.isAdmin, created_at: r.createdAt.toISOString(),
  ...(users === undefined ? {} : { users }),
});

export class RolesRepository {
  constructor(private db: PrismaClient) {}

  async list(): Promise<Role[]> {
    const rows = await this.db.role.findMany({ orderBy: [{ isAdmin: 'desc' }, { createdAt: 'asc' }], include: { _count: { select: { users: true } } } });
    return rows.map((r) => map(r, r._count.users));
  }

  async findById(id: string): Promise<Role | undefined> {
    const r = await this.db.role.findUnique({ where: { id } });
    return r ? map(r) : undefined;
  }

  async findByName(name: string): Promise<Role | undefined> {
    const r = await this.db.role.findUnique({ where: { name } });
    return r ? map(r) : undefined;
  }

  /** First admin role (there is always one: the system ADMIN). */
  async firstAdmin(): Promise<Role | undefined> {
    const r = await this.db.role.findFirst({ where: { isAdmin: true }, orderBy: { createdAt: 'asc' } });
    return r ? map(r) : undefined;
  }

  async create(input: { name: string; label: string; description?: string | null; is_admin?: boolean }): Promise<Role> {
    const r = await this.db.role.create({
      data: { id: newId(), name: input.name, label: input.label, description: input.description ?? null, isAdmin: !!input.is_admin, isSystem: false },
    });
    return map(r);
  }

  async update(id: string, patch: { label?: string; description?: string | null; is_admin?: boolean }): Promise<Role | undefined> {
    const current = await this.db.role.findUnique({ where: { id } });
    if (!current) return undefined;
    const r = await this.db.role.update({
      where: { id },
      data: {
        label: patch.label ?? current.label,
        description: patch.description === undefined ? current.description : patch.description,
        // system roles keep their admin flag
        isAdmin: current.isSystem ? current.isAdmin : (patch.is_admin ?? current.isAdmin),
      },
    });
    return map(r);
  }

  async delete(id: string): Promise<boolean> {
    return (await this.db.role.deleteMany({ where: { id, isSystem: false } })).count > 0;
  }

  async permissionsOf(roleId: string): Promise<PermissionGrant[]> {
    return (await this.db.permission.findMany({ where: { roleId } })).map((p) => ({ resource: p.resource, action: p.action }));
  }

  /** Flip one grant; returns the new state (true = granted). */
  async toggle(roleId: string, resource: string, action: string): Promise<boolean> {
    const existing = await this.db.permission.findUnique({ where: { resource_action_roleId: { resource, action, roleId } } });
    if (existing) {
      await this.db.permission.delete({ where: { id: existing.id } });
      return false;
    }
    await this.db.permission.create({ data: { id: newId(), resource, action, roleId } });
    return true;
  }

  /** Replace every grant of a role at once (used by "copy from" / presets). */
  async setAll(roleId: string, grants: PermissionGrant[]): Promise<void> {
    await this.db.$transaction([
      this.db.permission.deleteMany({ where: { roleId } }),
      this.db.permission.createMany({ data: grants.map((g) => ({ id: newId(), roleId, resource: g.resource, action: g.action })), skipDuplicates: true }),
    ]);
  }
}
