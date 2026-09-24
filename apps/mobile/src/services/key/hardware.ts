// Hardware device key: P-256 in the platform keystore/Secure Enclave, via
// @pagopa/io-react-native-crypto (design spec §2 "Device key"). Only exercised on a real
// device — this module is typechecked, not runtime-tested, in this task (see the app plan's
// first on-device check, P§11.1); Jest always uses SoftwareDeviceKey instead (index.ts).
//
// Two behaviours worth calling out:
// - `create()` deletes and retries on `KEY_ALREADY_EXISTS`: a new enrolment always starts from
//   a fresh key, so a leftover key from a previous, abandoned enrolment is not reused.
// - `exists()` reports "no key" (`false`) only for `PUBLIC_KEY_NOT_FOUND`; any other error
//   (e.g. a transient `KEYCHAIN_LOAD_FAILED`/`KEYSTORE_LOAD_FAILED`) is rethrown, so a caller
//   doing `if (!(await exists())) await create()` never mistakes a transient failure for "not
//   enrolled" and deletes/recreates a key that is actually still there.
import { deleteKey, generate, getPublicKeyFixed, sign as hwSign, type PublicKey } from '@pagopa/io-react-native-crypto';
import { fromB64std, fromUtf8 } from '../crypto/encoding';
import { derToRaw, normaliseLowS } from './jwk';
import type { DeviceKey, P256Jwk } from './types';

const KEY_TAG = 'dev.termhub.device';

// `getPublicKeyFixed`/`generate` return an ECKey | RSAKey union (RSA is only an Android
// fallback when no EC hardware key is available); the device key is always EC, so a non-EC
// result is treated as a hardware failure rather than silently coerced.
const normalise = (jwk: PublicKey): P256Jwk => {
  if (jwk.kty !== 'EC') throw new Error('UNSUPPORTED_KEY_TYPE');
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
};

export class HardwareDeviceKey implements DeviceKey {
  async create(): Promise<P256Jwk> {
    try {
      return normalise(await generate(KEY_TAG));
    } catch (err) {
      if ((err as { message?: string } | undefined)?.message === 'KEY_ALREADY_EXISTS') {
        await deleteKey(KEY_TAG);
        return normalise(await generate(KEY_TAG));
      }
      throw err;
    }
  }

  async exists(): Promise<boolean> {
    try {
      await getPublicKeyFixed(KEY_TAG);
      return true;
    } catch (err) {
      if ((err as { message?: string } | undefined)?.message === 'PUBLIC_KEY_NOT_FOUND') return false;
      throw err;
    }
  }

  async publicJwk(): Promise<P256Jwk> {
    return normalise(await getPublicKeyFixed(KEY_TAG));
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    // `sign` takes a UTF-8 string (the JWS signing input is always ASCII, so this is lossless)
    // and returns the DER signature as standard, padded base64 — decode that, convert to raw
    // r‖s, then normalise to low-S: the keystore/Secure Enclave does not do this itself, and
    // `verifyProof`'s ES256 check rejects high-S signatures by default.
    const derB64 = await hwSign(fromUtf8(message), KEY_TAG);
    return normaliseLowS(derToRaw(fromB64std(derB64)));
  }

  async destroy(): Promise<void> {
    await deleteKey(KEY_TAG);
  }
}
