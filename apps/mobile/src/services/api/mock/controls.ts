// `MockControls` — the "Aguardando aprovação" screen's simulation buttons and the test-only
// escape hatches for expiry, lock and revoke (design spec §4.2).
import { ACTIVATE_TTL_MS } from './handlers/devices';
import { PIN_LOCK_MS, revokeDevice, requestStatus, type MockState } from './state';

export interface MockControls {
  approve(requestId: string): void;
  deny(requestId: string): void;
  expireNow(): void;
  lockNow(): void;
  revokeNow(): void;
  dropSocket(): void;
  pendingRequestIds(): string[];
}

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
        device.lockedUntil = now() + PIN_LOCK_MS;
      }
    },

    revokeNow() {
      for (const device of state.devices.values()) {
        revokeDevice(state, device, 'admin');
      }
    },

    // Simulates the connection dropping so the app's reconnect logic can be watched — a normal,
    // non-terminal closure (unlike `4400`/`4401`), so the socket client schedules a reconnect
    // instead of wiping (design spec §4.2 "Controls").
    dropSocket() {
      for (const socket of state.sockets) socket.close(1006);
    },

    pendingRequestIds() {
      const nowMs = now();
      return [...state.requests.values()].filter((req) => requestStatus(req, nowMs) === 'pending').map((req) => req.id);
    },
  };
}
