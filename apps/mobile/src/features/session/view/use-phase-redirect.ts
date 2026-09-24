import type { Href } from 'expo-router';
import { useEffect } from 'react';
import type { Phase } from '../model/session.types';
import { useSessionStore } from '../viewmodel/useSessionStore';

/** Each phase's own screen (design spec §8). */
const HOME: Record<Phase, string> = {
  new: '/',
  waiting: '/enrol/waiting',
  pin_setup: '/enrol/create-pin',
  locked: '/unlock',
  unlocked: '/(tabs)',
};

/** Whether `segments` (from `useSegments()`) already sit inside `phase`'s own group. `unlocked`
 * owns both the tabs and the conversation screen (`app/chat/[id].tsx`, Task 13) — a deep link or
 * a tab-to-chat navigation must not get bounced back to `/(tabs)` on every render. */
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

/** The pure decision behind `usePhaseRedirect`: where (if anywhere) the route should be replaced.
 * `null` means the current route already matches `phase`. A set `pendingRoute` while `unlocked`
 * (a deep link caught while locked, P§9) always wins, followed once. Kept free of `expo-router`
 * and `react-native` imports so it is unit-testable on its own, in the `logic` project. */
export function redirectFor(phase: Phase, segments: string[], pendingRoute: string | null): string | null {
  if (phase === 'unlocked' && pendingRoute) return pendingRoute;
  if (onPhaseHome(phase, segments)) return null;
  return HOME[phase];
}

/**
 * Keeps the visible route in step with the session phase (design spec §8): each phase's screens
 * are reachable only while it is current, and once `unlocked` a stored `pendingRoute` is followed
 * once, then cleared.
 */
export function usePhaseRedirect(): void {
  // Required lazily, not at module scope: the `logic` Jest project throws on `expo-router`
  // (test/logic-setup.js), and this keeps `redirectFor` above importable — and unit-testable —
  // there without pulling the router in.
  const { useRouter, useSegments } = require('expo-router') as typeof import('expo-router');
  const router = useRouter();
  const segments = useSegments();
  const hydrated = useSessionStore((s) => s.hydrated);
  const phase = useSessionStore((s) => s.phase);
  const pendingRoute = useSessionStore((s) => s.pendingRoute);
  const clearPendingRoute = useSessionStore((s) => s.clearPendingRoute);

  useEffect(() => {
    if (!hydrated) return; // waiting for MMKV: redirecting before hydration would bounce a locked session to `new`.
    const target = redirectFor(phase, segments, pendingRoute);
    if (!target) return;
    router.replace(target as Href);
    if (phase === 'unlocked' && pendingRoute) clearPendingRoute();
  }, [hydrated, phase, pendingRoute, segments, router, clearPendingRoute]);
}
