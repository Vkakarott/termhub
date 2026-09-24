// The device-key diagnostic (P§11.1's first on-device check, design spec §10): runs every
// `DeviceKey` operation against a *dedicated* key the caller injects — `Ajustes` always builds it
// from `key.diagnostic` / `dev.termhub.diagnostic`, never the enrolled `key.private` — so the
// diagnostic can never disturb the real session (ruling: "the diagnostic never touches the
// enrolled key").
import { p256 } from '@noble/curves/nist.js';
import { utf8 } from '@/services/crypto/encoding';
import { jwkToUncompressed } from '@/services/key/jwk';
import type { DeviceKey, P256Jwk } from '@/services/key/types';

export interface KeyDiagnosticStep {
  name: string;
  ok: boolean;
  /** The error's own message on failure; absent on success. Never the key material. */
  detail?: string;
}

export interface KeyDiagnosticResult {
  ok: boolean;
  steps: KeyDiagnosticStep[];
}

const MESSAGE = utf8('termhub-key-diagnostic');

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * `create` / `exists` / `publicJwk` / `sign+verify` / `destroy`, in order (P§11.1). Every step
 * runs even after an earlier one failed, so a broken `sign()` still gets to `destroy()` — the
 * diagnostic never leaves a half-made key behind. A step's own thrown error becomes `ok: false`
 * with its `message` as `detail`; nothing about the key itself is ever put in a detail string.
 */
export async function runKeyDiagnostic(key: DeviceKey): Promise<KeyDiagnosticResult> {
  const steps: KeyDiagnosticStep[] = [];
  let created: P256Jwk | null = null;

  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      steps.push({ name, ok: true });
    } catch (e) {
      steps.push({ name, ok: false, detail: messageOf(e) });
    }
  };

  await step('create', async () => {
    created = await key.create();
    if (created.kty !== 'EC' || created.crv !== 'P-256') throw new Error('A chave criada não é P-256.');
  });

  await step('exists', async () => {
    if (!(await key.exists())) throw new Error('A chave não existe depois de criada.');
  });

  await step('publicJwk', async () => {
    const pub = await key.publicJwk();
    if (!created || pub.x !== created.x || pub.y !== created.y) throw new Error('A chave pública não confere com a criada.');
  });

  await step('sign+verify', async () => {
    const sig = await key.sign(MESSAGE);
    if (sig.length !== 64) throw new Error('A assinatura não tem 64 bytes.');
    if (!created) throw new Error('Sem chave pública para verificar a assinatura.');
    if (!p256.verify(sig, MESSAGE, jwkToUncompressed(created), { prehash: true })) {
      throw new Error('A assinatura não passou na verificação.');
    }
  });

  await step('destroy', async () => {
    await key.destroy();
    if (await key.exists()) throw new Error('A chave ainda existe depois de destruída.');
  });

  return { ok: steps.every((s) => s.ok), steps };
}
