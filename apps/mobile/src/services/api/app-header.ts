/**
 * `X-Termhub-App: ios/1.2.0+34` — sent on every call so the server can refuse a build that must
 * not run any more (`426 APP_TOO_OLD`, spec §6). Pure: the caller supplies what expo-application
 * reports, so this runs in the `logic` jest project.
 */
export type AppPlatform = 'ios' | 'android';

export function appHeader(platform: AppPlatform, version: string | null, build: string | null): string {
  const v = version && /^\d+(\.\d+){0,2}$/.test(version) ? version : '0.0.0';
  const b = build && /^\d+$/.test(build) ? build : '0';
  return `${platform}/${v}+${b}`;
}
