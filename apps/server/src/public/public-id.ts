import { createHmac, randomBytes } from 'node:crypto';
import type { Repositories } from '../db/repositories/index.js';

/**
 * The public city's ids: a leaf module on purpose (it imports no repository code at runtime), since
 * the repository mappers call it and anything it imported back would be a cycle at module init.
 */

/** The `instance_secrets` row that holds the key. */
export const PUBLIC_ID_KEY_NAME = 'public_id';

let key: Buffer | null = null;

/** Called once at boot, before the server listens (and by tests). `null` unloads it. */
export function setPublicIdKey(next: Buffer | null): void {
  key = next;
}

/** A fresh random key, base64 — what the first container to boot stores for every later one. */
export function generatePublicIdKey(): string {
  return randomBytes(32).toString('base64');
}

/** The instance's key, created on first boot and the same on every container after that. */
export async function loadPublicIdKey(repos: Pick<Repositories, 'instanceSecrets'>): Promise<Buffer> {
  return Buffer.from(await repos.instanceSecrets.ensure(PUBLIC_ID_KEY_NAME, generatePublicIdKey), 'base64');
}

/**
 * A one-way id for the street: HMAC-SHA256 of the real id with the instance's own secret (spec §5).
 * Without the key, holding a real id (an old collaborator, a log line, a screenshot) is not enough to
 * compute its public id and confirm whether that project is published, or in whose city. Same input,
 * same output on every container — the key lives in the database both colors share — so a snapshot
 * from one and a socket frame from the other agree during a blue/green switch. Synchronous: the key
 * is loaded before the server listens, and asking for an id before that is a bug, not a fallback.
 */
export function publicId(kind: 'machine' | 'project' | 'tab', realId: string): string {
  if (!key) throw new Error('public id key not loaded');
  return createHmac('sha256', key).update(`${kind}:${realId}`).digest('base64url').slice(0, 22);
}
