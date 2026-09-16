import type { DB } from '../connection.js';
import { newId } from '../../lib/ids.js';
import type { User, UserRole } from './types.js';

export class UsersRepository {
  constructor(private db: DB) {}

  findById(id: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }

  findByEmail(email: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim()) as
      | User
      | undefined;
  }

  findByGoogleId(googleId: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId) as User | undefined;
  }

  /** Primeiro owner (ou primeiro usuário criado). Usado em AUTH_MODE=disabled. */
  findFirstOwner(): User | undefined {
    return this.db
      .prepare("SELECT * FROM users ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC LIMIT 1")
      .get() as User | undefined;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  create(input: {
    email: string;
    name: string;
    password_hash?: string | null;
    role?: UserRole;
    avatar_url?: string | null;
  }): User {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO users (id, email, name, password_hash, role, avatar_url)
         VALUES (@id, @email, @name, @password_hash, @role, @avatar_url)`,
      )
      .run({
        id,
        email: input.email.trim().toLowerCase(),
        name: input.name.trim(),
        password_hash: input.password_hash ?? null,
        role: input.role ?? 'member',
        avatar_url: input.avatar_url ?? null,
      });
    return this.findById(id)!;
  }

  linkGoogle(userId: string, googleId: string, avatarUrl?: string | null): void {
    this.db
      .prepare('UPDATE users SET google_id = ?, avatar_url = COALESCE(?, avatar_url) WHERE id = ?')
      .run(googleId, avatarUrl ?? null, userId);
  }

  setPassword(userId: string, passwordHash: string): void {
    this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
  }
}
