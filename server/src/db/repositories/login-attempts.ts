import type { DB } from '../connection.js';

interface AttemptRow {
  key: string;
  failures: number;
  locked_until: string | null;
  updated_at: string;
}

/**
 * Lockout progressivo: a cada falha acima do limite, o tempo de bloqueio dobra.
 * Chave pode ser "email:<email>" ou "ip:<ip>".
 */
export class LoginAttemptsRepository {
  constructor(
    private db: DB,
    private opts = { freeAttempts: 5, baseLockMs: 30_000, maxLockMs: 60 * 60 * 1000, resetAfterMs: 24 * 60 * 60 * 1000 },
  ) {}

  /** Retorna ms restantes de bloqueio (0 se livre). */
  lockedFor(key: string): number {
    const row = this.db.prepare('SELECT * FROM login_attempts WHERE key = ?').get(key) as AttemptRow | undefined;
    if (!row?.locked_until) return 0;
    const remaining = new Date(row.locked_until).getTime() - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  recordFailure(key: string): number {
    const now = Date.now();
    const row = this.db.prepare('SELECT * FROM login_attempts WHERE key = ?').get(key) as AttemptRow | undefined;
    let failures = 1;
    if (row && now - new Date(row.updated_at).getTime() < this.opts.resetAfterMs) failures = row.failures + 1;

    let lockedUntil: string | null = null;
    if (failures >= this.opts.freeAttempts) {
      const exp = failures - this.opts.freeAttempts;
      const lockMs = Math.min(this.opts.baseLockMs * 2 ** exp, this.opts.maxLockMs);
      lockedUntil = new Date(now + lockMs).toISOString();
    }
    this.db
      .prepare(
        `INSERT INTO login_attempts (key, failures, locked_until, updated_at)
         VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(key) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until,
           updated_at = excluded.updated_at`,
      )
      .run(key, failures, lockedUntil);
    return lockedUntil ? new Date(lockedUntil).getTime() - now : 0;
  }

  clear(key: string): void {
    this.db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
  }
}
