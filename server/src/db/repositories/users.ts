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

  /** Primeiro owner (ou primeiro usuário criado). Usado em AUTH_MODE=disabled. */
  async findFirstOwner(): Promise<User | undefined> {
    const u =
      (await this.db.user.findFirst({ where: { role: 'owner' }, orderBy: { createdAt: 'asc' } })) ??
      (await this.db.user.findFirst({ orderBy: { createdAt: 'asc' } }));
    return u ? mapUser(u) : undefined;
  }

  count(): Promise<number> {
    return this.db.user.count();
  }

  async create(input: {
    email: string;
    name: string;
    password_hash?: string | null;
    role?: UserRole;
    avatar_url?: string | null;
  }): Promise<User> {
    const u = await this.db.user.create({
      data: {
        id: newId(),
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        passwordHash: input.password_hash ?? null,
        role: input.role ?? 'member',
        avatarUrl: input.avatar_url ?? null,
      },
    });
    return mapUser(u);
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
}
