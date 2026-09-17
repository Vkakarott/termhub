import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * AES-256-GCM para segredos no banco (tokens de integrações).
 * Formato: base64(iv) . base64(tag) . base64(ciphertext)
 */
function key(): Buffer {
  if (!config.encryptionKey) throw new Error('ENCRYPTION_KEY não configurada (openssl rand -base64 32)');
  const k = Buffer.from(config.encryptionKey, 'base64');
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY precisa ter 32 bytes em base64');
  return k;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

export function decryptSecret(stored: string): string {
  const [iv, tag, enc] = stored.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

export function encryptionAvailable(): boolean {
  return !!config.encryptionKey;
}
