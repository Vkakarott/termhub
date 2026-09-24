// Copied verbatim from packages/mobile-api/src/version.ts @ c6bab0a (feat/mobile-chat-server).
// Replaced by `import … from '@termhub/mobile-api' once that package is on main. Do not edit here.
export const MOBILE_API_VERSION = 1;

const HEADER_RE = /^(ios|android)\/(\d+\.\d+\.\d+)\+(\d+)$/;

/** Parses the phone app's `X-App-Version` header, e.g. `ios/1.2.0+34`. Returns null for anything
 * that does not match, including a missing header. */
export function parseAppHeader(v: string | undefined): { platform: 'ios' | 'android'; version: string; build: number } | null {
  const m = v?.match(HEADER_RE);
  // Not part of the copy: `packages/mobile-api`'s own tsconfig does not set `noUncheckedIndexedAccess`
  // (apps/mobile's does), so `m[2]` types as `string | undefined` here only in this project. `m` is
  // truthy, so the three capture groups of `HEADER_RE` all matched.
  // @ts-expect-error -- see above; m[2] is a matched capture group, never undefined here.
  return m ? { platform: m[1] as 'ios' | 'android', version: m[2], build: Number(m[3]) } : null;
}

/** Compares two `x.y.z` version strings numerically, part by part — never lexically, so `1.10.0`
 * sorts above `1.9.0`. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number),
    pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}
