// Chosen once at boot (design spec §3.1): the device key is the hardware one only under the real
// API mode, and never under Jest — `NODE_ENV === 'test'` guards against constructing `HardwareDeviceKey` (a
// native module) at module load time in every other test file that imports this.
import { HardwareDeviceKey } from './hardware';
import { SoftwareDeviceKey } from './software';
import type { DeviceKey } from './types';

export const deviceKey: DeviceKey =
  process.env.EXPO_PUBLIC_API_MODE === 'http' && process.env.NODE_ENV !== 'test' ? new HardwareDeviceKey() : new SoftwareDeviceKey();

/** The Ajustes → "Diagnóstico da chave" key (design spec §10): always the hardware key outside
 * Jest, whatever the API mode — mock is the only mode that runs without a server, and the check
 * exists to exercise the Secure Enclave / Keystore. Its tag is dedicated (never `deviceKey`'s),
 * so the diagnostic can never disturb the enrolled session. */
export const diagnosticKey: DeviceKey =
  process.env.NODE_ENV !== 'test' ? new HardwareDeviceKey('dev.termhub.diagnostic') : new SoftwareDeviceKey('key.diagnostic');
