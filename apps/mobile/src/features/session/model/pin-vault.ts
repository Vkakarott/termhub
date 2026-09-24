// The PIN-wrapped secret in the vault (design spec §5.3-5.4): pure helpers over the vault port.
// The PIN is never compared here — any PIN unwraps to 32 plausible bytes, and only the server
// can tell a right one from a wrong one (P§5.4).
import { b64url, fromB64url } from '@/services/crypto/encoding';
import { deriveWrapKey, unwrapSecret, wrapSecret } from '@/services/crypto/pin';
import { randomBytes } from '@/services/crypto/random';
import type { vault as Vault } from '@/services/vault';

type VaultPort = typeof Vault;

/** Wraps `secret` under the PIN and stores it with a fresh salt and the device id. */
export async function storeWrappedSecret(vault: VaultPort, pin: string, secret: Uint8Array, deviceId: string): Promise<void> {
  const salt = randomBytes(16);
  const wrapped = wrapSecret(secret, await deriveWrapKey(pin, salt));
  await vault.set('pin.wrapped', b64url(wrapped));
  await vault.set('pin.salt', b64url(salt));
  await vault.set('device.id', deviceId);
}

/** The candidate secret for `pin`; `null` when the vault is missing its items or belongs to
 * another device — a half session, which only a wipe can end. */
export async function unwrapWithPin(vault: VaultPort, pin: string, deviceId: string | null): Promise<Uint8Array | null> {
  const [wrapped, salt, storedId] = await Promise.all([vault.get('pin.wrapped'), vault.get('pin.salt'), vault.get('device.id')]);
  if (!wrapped || !salt || !storedId || storedId !== deviceId) return null;
  return unwrapSecret(fromB64url(wrapped), await deriveWrapKey(pin, fromB64url(salt)));
}

/** The plain secret behind the OS biometric prompt; `null` on any failure (falls back to the PIN). */
export async function readBiometricSecret(vault: VaultPort): Promise<Uint8Array | null> {
  try {
    const s = await vault.get('pin.biometric', true);
    return s ? fromB64url(s) : null;
  } catch {
    return null;
  }
}
