// `MockControls` — the "Aguardando aprovação" screen's simulation buttons and the test-only
// escape hatches for expiry, lock and revoke (design spec §4.2).
import { ACTIVATE_TTL_MS } from './handlers/devices';
import { revokeDevice, requestStatus, type MockState } from './state';

export interface MockControls {
  approve(requestId: string): void;
  deny(requestId: string): void;
  expireNow(): void;
  lockNow(): void;
  revokeNow(): void;
  dropSocket(): void;
  pendingRequestIds(): string[];
}

const LOCK_MS = 15 * 60_000;

export function createMockControls(state: MockState, now: () => number): MockControls {
  return {
    approve(requestId) {
      const req = state.requests.get(requestId);
      if (!req || req.status !== 'pending') return;
      req.status = 'approved';
      req.activateUntil = now() + ACTIVATE_TTL_MS;
    },

    deny(requestId) {
      const req = state.requests.get(requestId);
      if (!req || req.status !== 'pending') return;
      req.status = 'denied';
    },

    expireNow() {
      for (const req of state.requests.values()) {
        if (req.status === 'pending') req.expiresAt = now() - 1;
      }
    },

    lockNow() {
      for (const device of state.devices.values()) {
        device.lockedUntil = now() + LOCK_MS;
      }
    },

    revokeNow() {
      for (const device of state.devices.values()) {
        revokeDevice(state, device, 'admin');
      }
    },

    // Simulates the connection dropping so the app's reconnect logic can be watched — a normal
    // closure, not the terminal `4401`/`4400` codes. Task 9 gives `connect()` a real fake socket
    // that populates `state.sockets`; until then this is a no-op over an empty set (ruling 1).
    dropSocket() {
      for (const socket of state.sockets) socket.close(1000);
    },

    pendingRequestIds() {
      const nowMs = now();
      return [...state.requests.values()].filter((req) => requestStatus(req, nowMs) === 'pending').map((req) => req.id);
    },
  };
}
