import type { Repositories } from '../db/repositories/index.js';
import type { User } from '../db/repositories/types.js';
import { config } from '../config.js';
import { verifyPassword } from './password.js';
import { generateToken, hashToken } from './tokens.js';

export type LoginResult =
  | { ok: true; user: User }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'locked'; retryAfterMs: number };

/** Regras de autenticação independentes de HTTP (testáveis isoladamente). */
export class AuthService {
  constructor(private repos: Repositories) {}

  async loginWithPassword(email: string, password: string, ip: string): Promise<LoginResult> {
    const emailKey = `email:${email.trim().toLowerCase()}`;
    const ipKey = `ip:${ip}`;

    const locked = Math.max(this.repos.loginAttempts.lockedFor(emailKey), this.repos.loginAttempts.lockedFor(ipKey));
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };

    const user = this.repos.users.findByEmail(email);
    const valid = await verifyPassword(user?.password_hash ?? null, password);
    if (!user || !valid) {
      const a = this.repos.loginAttempts.recordFailure(emailKey);
      const b = this.repos.loginAttempts.recordFailure(ipKey);
      const lock = Math.max(a, b);
      if (lock > 0) return { ok: false, reason: 'locked', retryAfterMs: lock };
      return { ok: false, reason: 'invalid' };
    }

    this.repos.loginAttempts.clear(emailKey);
    this.repos.loginAttempts.clear(ipKey);
    return { ok: true, user };
  }

  /** Google só entra se o e-mail já estiver cadastrado. Vincula google_id na primeira vez. */
  loginWithGoogle(profile: { sub: string; email: string; emailVerified: boolean; picture?: string }): User | null {
    if (!profile.emailVerified) return null;
    const byGoogle = this.repos.users.findByGoogleId(profile.sub);
    if (byGoogle) return byGoogle;
    const byEmail = this.repos.users.findByEmail(profile.email);
    if (!byEmail) return null;
    if (byEmail.google_id && byEmail.google_id !== profile.sub) return null;
    this.repos.users.linkGoogle(byEmail.id, profile.sub, profile.picture);
    return this.repos.users.findById(byEmail.id)!;
  }

  /** Cria sessão e devolve o token opaco (só o hash vai pro banco). */
  createSession(userId: string): { token: string; csrf: string; expiresAt: Date } {
    const token = generateToken(32);
    const expiresAt = new Date(Date.now() + config.auth.sessionTtlMs);
    this.repos.sessions.create(userId, hashToken(token), expiresAt);
    return { token, csrf: generateToken(24), expiresAt };
  }

  resolveSession(token: string): User | null {
    const found = this.repos.sessions.findValidByTokenHash(hashToken(token));
    return found?.user ?? null;
  }

  destroySession(token: string): void {
    this.repos.sessions.deleteByTokenHash(hashToken(token));
  }

  purgeExpiredSessions(): number {
    return this.repos.sessions.purgeExpired();
  }
}
