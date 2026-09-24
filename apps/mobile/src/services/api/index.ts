// The app-wide `MobileApi` singleton (design spec §4.1). `src/services` must not import
// `react-native`, so platform/version come from `expo-application` and `expo-device` instead of
// `Platform` — both are already mocked under Jest (`test/logic-setup.js`, `test/ui-setup.js`).
import * as Application from 'expo-application';
import * as Device from 'expo-device';
import { appHeader, type AppPlatform } from './app-header';
import { createHttpMobileApi } from './client';
import { TERMHUB_URL } from './config';
import { FetchTransport } from './transport';
import type { MobileApi } from './types';
import { deviceKey } from '../key';

const platform: AppPlatform = Device.osName === 'iOS' ? 'ios' : 'android';
const app = appHeader(platform, Application.nativeApplicationVersion, Application.nativeBuildVersion);

const mode: 'mock' | 'http' = process.env.EXPO_PUBLIC_API_MODE === 'mock' ? 'mock' : 'http';

// The session store (Task 10) calls this once at boot to register its single-flighted
// `challenge` + `token` renewal, without `index.ts` having to import the store (which would be a
// require cycle: the store imports `api` to make calls).
let renewer: () => Promise<string | null> = async () => null;
export function setTokenRenewer(fn: () => Promise<string | null>): void {
  renewer = fn;
}

// `new FetchTransport()` regardless of `mode` for now: Task 8 adds `createMockTransport()` and
// switches this to it when `mode === 'mock'`.
export const api: MobileApi = createHttpMobileApi({
  transport: new FetchTransport(),
  baseUrl: TERMHUB_URL,
  app,
  key: deviceKey,
  onTokenExpired: () => renewer(),
  mode,
});

// The mock transport's controls (`approve`, `deny`, ...), reached by the *Aguardando* screen
// through the viewmodel's `mockControls` field. `null` in `http` mode; Task 8 gives this its real
// type and value in `mock` mode.
export const mockControls: null = null;
