import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapUser, type User, type UserRole } from './types.js';

export class UsersRepository {
  constructor(private db: PrismaClient) {}

  async findById(id: string): Promise<User | undefined> {
    const u = await this.db.user.findUnique({ where: { id } });
    return u ? mapUser(u) : undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const u = await this.db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    return u ? mapUser(u) : undefined;
  }

  async findByGoogleId(googleId: string): Promise<User | undefined> {
    const u = await this.db.user.findUnique({ where: { googleId } });
    return u ? mapUser(u) : undefined;
  }

  /** First admin (or first user created). Used in AUTH_MODE=disabled. */
  async findFirstOwner(): Promise<User | undefined> {
    const u =
      (await this.db.user.findFirst({ where: { roleRef: { isAdmin: true } }, orderBy: { createdAt: 'asc' } })) ??
      (await this.db.user.findFirst({ where: { role: 'owner' }, orderBy: { createdAt: 'asc' } })) ??
      (await this.db.user.findFirst({ orderBy: { createdAt: 'asc' } }));
    return u ? mapUser(u) : undefined;
  }

  count(): Promise<number> {
    return this.db.user.count();
  }

  async list(): Promise<User[]> {
    return (await this.db.user.findMany({ orderBy: { createdAt: 'asc' } })).map(mapUser);
  }

  async countByRole(roleId: string): Promise<number> {
    return this.db.user.count({ where: { roleId } });
  }

  async countAdmins(): Promise<number> {
    return this.db.user.count({ where: { roleRef: { isAdmin: true } } });
  }

  async create(input: {
    email: string;
    name: string;
    password_hash?: string | null;
    /** DEPRECATED legacy flag, derived from the role when omitted */
    role?: UserRole;
    role_id: string;
    avatar_url?: string | null;
    invited_at?: Date | null;
  }): Promise<User> {
    const u = await this.db.user.create({
      data: {
        id: newId(),
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        passwordHash: input.password_hash ?? null,
        role: input.role ?? 'member',
        roleId: input.role_id,
        avatarUrl: input.avatar_url ?? null,
        invitedAt: input.invited_at ?? null,
      },
    });
    return mapUser(u);
  }

  async touchLogin(userId: string): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  }

  async setRole(userId: string, roleId: string, legacy: UserRole): Promise<User | undefined> {
    const u = await this.db.user.update({ where: { id: userId }, data: { roleId, role: legacy } });
    return mapUser(u);
  }

  async delete(userId: string): Promise<boolean> {
    return (await this.db.user.deleteMany({ where: { id: userId } })).count > 0;
  }

  async linkGoogle(userId: string, googleId: string, avatarUrl?: string | null): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { googleId, ...(avatarUrl ? { avatarUrl } : {}) },
    });
  }

  async setPassword(userId: string, passwordHash: string): Promise<void> {
    await this.db.user.update({ where: { id: userId }, data: { passwordHash } });
  }

  /** Claims a nickname for this user. 'taken' when another account already holds it (unique index). */
  async setNickname(userId: string, nickname: string): Promise<'ok' | 'taken'> {
    const holder = await this.db.user.findUnique({ where: { nickname } });
    if (holder && holder.id !== userId) return 'taken';
    await this.db.user.update({ where: { id: userId }, data: { nickname } });
    return 'ok';
  }

  async findByNickname(nickname: string): Promise<User | undefined> {
    const u = await this.db.user.findUnique({ where: { nickname } });
    return u ? mapUser(u) : undefined;
  }
}
