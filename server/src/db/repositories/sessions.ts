import type { DB } from '../connection.js';
import { newId } from '../../lib/ids.js';
import type { Session, User } from './types.js';

export class SessionsRepository {
  constructor(private db: DB) {}

  create(userId: string, tokenHash: string, expiresAt: Date): Session {
    const id = newId();
    this.db
      .prepare('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
      .run(id, userId, tokenHash, expiresAt.toISOString());
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session;
  }

  /** Retorna a sessão + usuário se o token for válido e não expirado. */
  findValidByTokenHash(tokenHash: string): { session: Session; user: User } | undefined {
    const row = this.db
      .prepare(
        `SELECT s.id AS s_id, s.user_id AS s_user_id, s.token_hash AS s_token_hash,
                s.expires_at AS s_expires_at, s.created_at AS s_created_at, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .get(tokenHash) as (User & Record<string, unknown>) | undefined;
    if (!row) return undefined;
    const { s_id, s_user_id, s_token_hash, s_expires_at, s_created_at, ...user } = row;
    return {
      session: {
        id: s_id as string,
        user_id: s_user_id as string,
        token_hash: s_token_hash as string,
        expires_at: s_expires_at as string,
        created_at: s_created_at as string,
      },
      user: user as User,
    };
  }

  deleteByTokenHash(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteAllForUser(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  purgeExpired(): number {
    return this.db.prepare("DELETE FROM sessions WHERE expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now')").run()
      .changes;
  }
}
