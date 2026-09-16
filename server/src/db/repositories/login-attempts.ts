import type { PrismaClient } from '../prisma.js';

/**
 * Lockout progressivo: a cada falha acima do limite, o tempo de bloqueio dobra.
 * Chave pode ser "email:<email>" ou "ip:<ip>".
 */
export class LoginAttemptsRepository {
  constructor(
    private db: PrismaClient,
    private opts = { freeAttempts: 5, baseLockMs: 30_000, maxLockMs: 60 * 60 * 1000, resetAfterMs: 24 * 60 * 60 * 1000 },
  ) {}

  /** Retorna ms restantes de bloqueio (0 se livre). */
  async lockedFor(key: string): Promise<number> {
    const row = await this.db.loginAttempt.findUnique({ where: { key } });
    if (!row?.lockedUntil) return 0;
    const remaining = row.lockedUntil.getTime() - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  async recordFailure(key: string): Promise<number> {
    const now = Date.now();
    const row = await this.db.loginAttempt.findUnique({ where: { key } });
    let failures = 1;
    if (row && now - row.updatedAt.getTime() < this.opts.resetAfterMs) failures = row.failures + 1;

    let lockedUntil: Date | null = null;
    if (failures >= this.opts.freeAttempts) {
      const exp = failures - this.opts.freeAttempts;
      const lockMs = Math.min(this.opts.baseLockMs * 2 ** exp, this.opts.maxLockMs);
      lockedUntil = new Date(now + lockMs);
    }
    await this.db.loginAttempt.upsert({
      where: { key },
      create: { key, failures, lockedUntil, updatedAt: new Date(now) },
      update: { failures, lockedUntil, updatedAt: new Date(now) },
    });
    return lockedUntil ? lockedUntil.getTime() - now : 0;
  }

  async clear(key: string): Promise<void> {
    await this.db.loginAttempt.deleteMany({ where: { key } });
  }
}
