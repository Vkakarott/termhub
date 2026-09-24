// The pure routing decision behind `usePhaseRedirect` (design spec §8). No `expo-router` or
// `react-native` import, so it is a plain model module: testable on its own and safe under the
// `logic` Jest project, same as every other file in `model/`.
import type { Phase } from './session.types';

/** Each phase's own screen. */
const HOME: Record<Phase, string> = {
  new: '/',
  waiting: '/enrol/waiting',
  pin_setup: '/enrol/create-pin',
  locked: '/unlock',
  unlocked: '/(tabs)',
};

/** Whether `segments` (from `useSegments()`) already sit inside `phase`'s own group. `unlocked`
 * owns both the tabs and the conversation screen (`app/chat/[id].tsx`) — a deep link or a
 * tab-to-chat navigation must not get bounced back to `/(tabs)` on every render. */
function onPhaseHome(phase: Phase, segments: string[]): boolean {
  switch (phase) {
    case 'new':
      return segments.length === 0;
    case 'waiting':
      return segments[0] === 'enrol' && segments[1] === 'waiting';
    case 'pin_setup':
      return segments[0] === 'enrol' && segments[1] === 'create-pin';
    case 'locked':
      return segments[0] === 'unlock';
    case 'unlocked':
      return segments[0] === '(tabs)' || segments[0] === 'chat';
  }
}

export interface RedirectDecision {
  /** Where to `router.replace` to, or `null` when the current route already matches `phase`. */
  target: string | null;
  /** Whether the hook may clear `pendingRoute` on this pass. */
  shouldClear: boolean;
}

/**
 * `null`/`false` when the current route already matches `phase`. A set `pendingRoute` while
 * `unlocked` (a deep link caught while locked, P§9) always wins over the phase's own home — but
 * it is only *cleared* once `segments` shows it was actually reached: clearing in the same pass
 * that issues the `replace` would let a stale `segments` value (still the old route, one render
 * behind) fall through to `HOME.unlocked` and override the deep link with a second redirect.
 */
export function redirectFor(phase: Phase, segments: string[], pendingRoute: string | null): RedirectDecision {
  if (phase === 'unlocked' && pendingRoute) {
    const pendingFirstSegment = pendingRoute.split('/').filter(Boolean)[0] ?? null;
    const arrived = segments[0] === pendingFirstSegment;
    return arrived ? { target: null, shouldClear: true } : { target: pendingRoute, shouldClear: false };
  }
  if (onPhaseHome(phase, segments)) return { target: null, shouldClear: false };
  return { target: HOME[phase], shouldClear: false };
}
