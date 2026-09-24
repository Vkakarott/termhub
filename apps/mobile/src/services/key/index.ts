// Chosen once at boot (design spec §3.1): the hardware key only under the real API mode, and
// never under Jest — `NODE_ENV === 'test'` guards against constructing `HardwareDeviceKey` (a
// native module) at module load time in every other test file that imports this.
import { HardwareDeviceKey } from './hardware';
import { SoftwareDeviceKey } from './software';
import type { DeviceKey } from './types';

export const deviceKey: DeviceKey =
  process.env.EXPO_PUBLIC_API_MODE === 'http' && process.env.NODE_ENV !== 'test' ? new HardwareDeviceKey() : new SoftwareDeviceKey();
