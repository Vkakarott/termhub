import type { PrismaClient } from '../prisma.js';
import { newId } from '../../lib/ids.js';

export interface LoginCode {
  id: string;
  email: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  used_at: Date | null;
  created_at: Date;
}

/** Códigos de login por e-mail (OTP). Só o hash do código é guardado. */
export class LoginCodesRepository {
  constructor(private db: PrismaClient) {}

  async create(email: string, codeHash: string, expiresAt: Date): Promise<LoginCode> {
    const c = await this.db.loginCode.create({ data: { id: newId(), email, codeHash, expiresAt } });
    return this.map(c);
  }

  /** Último código ainda não usado para o e-mail. */
  async findLatestUnused(email: string): Promise<LoginCode | undefined> {
    const c = await this.db.loginCode.findFirst({ where: { email, usedAt: null }, orderBy: { createdAt: 'desc' } });
    return c ? this.map(c) : undefined;
  }

  countSince(email: string, since: Date): Promise<number> {
    return this.db.loginCode.count({ where: { email, createdAt: { gt: since } } });
  }

  async incrementAttempts(id: string): Promise<number> {
    const c = await this.db.loginCode.update({ where: { id }, data: { attempts: { increment: 1 } } });
    return c.attempts;
  }

  async markUsed(id: string): Promise<void> {
    await this.db.loginCode.update({ where: { id }, data: { usedAt: new Date() } });
  }

  /** Invalida todos os códigos pendentes do e-mail (após login ou novo envio). */
  async invalidateAll(email: string): Promise<void> {
    await this.db.loginCode.updateMany({ where: { email, usedAt: null }, data: { usedAt: new Date() } });
  }

  async purgeExpired(): Promise<number> {
    const r = await this.db.loginCode.deleteMany({ where: { expiresAt: { lte: new Date(Date.now() - 24 * 60 * 60 * 1000) } } });
    return r.count;
  }

  private map(c: {
    id: string;
    email: string;
    codeHash: string;
    expiresAt: Date;
    attempts: number;
    usedAt: Date | null;
    createdAt: Date;
  }): LoginCode {
    return {
      id: c.id,
      email: c.email,
      code_hash: c.codeHash,
      expires_at: c.expiresAt,
      attempts: c.attempts,
      used_at: c.usedAt,
      created_at: c.createdAt,
    };
  }
}
