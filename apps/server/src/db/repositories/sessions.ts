import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';
import { mapSession, mapUser, type Session, type User } from './types.js';

export class SessionsRepository {
  constructor(private db: PrismaClient) {}

  async create(userId: string, tokenHash: string, expiresAt: Date): Promise<Session> {
    const s = await this.db.session.create({ data: { id: newId(), userId, tokenHash, expiresAt } });
    return mapSession(s);
  }

  /** Retorna a sessão + usuário se o token for válido e não expirado. */
  async findValidByTokenHash(tokenHash: string): Promise<{ session: Session; user: User } | undefined> {
    const s = await this.db.session.findFirst({
      where: { tokenHash, expiresAt: { gt: new Date() } },
      include: { user: true },
    });
    if (!s) return undefined;
    return { session: mapSession(s), user: mapUser(s.user) };
  }

  async deleteByTokenHash(tokenHash: string): Promise<void> {
    await this.db.session.deleteMany({ where: { tokenHash } });
  }

  async deleteAllForUser(userId: string): Promise<void> {
    await this.db.session.deleteMany({ where: { userId } });
  }

  async purgeExpired(): Promise<number> {
    const r = await this.db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    return r.count;
  }
}
