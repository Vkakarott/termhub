import { useRouter, useSegments, type Href } from 'expo-router';
import { useEffect } from 'react';
import type { Phase } from '../model/session.types';
import { useSessionStore } from '../viewmodel/useSessionStore';

/** Each phase's own screen (design spec §8). */
const HOME: Record<Phase, Href> = {
  new: '/',
  waiting: '/enrol/waiting',
  pin_setup: '/enrol/create-pin',
  locked: '/unlock',
  unlocked: '/(tabs)',
};

/** Whether `segments` (from `useSegments()`) already sit inside `phase`'s own group. */
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
      return segments[0] === '(tabs)';
  }
}

/**
 * Keeps the visible route in step with the session phase (design spec §8): each phase's screens
 * are reachable only while it is current, and once `unlocked` a stored `pendingRoute` (a deep
 * link caught while locked, P§9) is followed once, then cleared.
 */
export function usePhaseRedirect(): void {
  const router = useRouter();
  const segments = useSegments();
  const hydrated = useSessionStore((s) => s.hydrated);
  const phase = useSessionStore((s) => s.phase);
  const pendingRoute = useSessionStore((s) => s.pendingRoute);
  const clearPendingRoute = useSessionStore((s) => s.clearPendingRoute);

  useEffect(() => {
    if (!hydrated) return; // waiting for MMKV: redirecting before hydration would bounce a locked session to `new`.
    if (phase === 'unlocked' && pendingRoute) {
      router.replace(pendingRoute as Href);
      clearPendingRoute();
      return;
    }
    if (!onPhaseHome(phase, segments)) router.replace(HOME[phase]);
  }, [hydrated, phase, pendingRoute, segments, router, clearPendingRoute]);
}
