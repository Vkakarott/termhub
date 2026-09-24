// What the enrolment request says about this phone (P§4, `deviceRequestBody`): read from
// `expo-device` / `expo-application`, trimmed to the contract's limits, never empty.
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import type { TDeviceRequestBody } from '@/services/api/contract';

function clean(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/** `x.y.z+build`, as the contract requires; `0.0.0+0` when the native values are unusable. */
function appVersion(version: string | null, build: string | null): string {
  if (!version || !/^\d+(\.\d+){0,2}$/.test(version) || !build || !/^\d+$/.test(build)) return '0.0.0+0';
  const parts = version.split('.');
  while (parts.length < 3) parts.push('0');
  return `${parts.join('.')}+${build}`;
}

export function readDeviceInfo(): Pick<TDeviceRequestBody, 'device' | 'app_version'> {
  const platform = Device.osName === 'iOS' || Device.osName === 'iPadOS' ? 'ios' : 'android';
  return {
    device: {
      platform,
      model: clean(Device.modelName, 80) ?? (platform === 'ios' ? 'iPhone' : 'Android'),
      os_version: clean(Device.osVersion, 40) ?? '0',
      name: clean(Device.deviceName, 60) ?? 'Celular',
    },
    app_version: appVersion(Application.nativeApplicationVersion, Application.nativeBuildVersion),
  };
}
