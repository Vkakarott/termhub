import type { WebSocket } from 'ws';
import type { Device } from '../db/repositories/devices.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Mailer } from '../email/mailer.js';

/** Why a device was revoked, and who did it; written to the device trail once Task 9 wires the event. */
export interface RevokeInput {
  reason: 'user' | 'admin' | 'pin_bruteforce' | 'review';
  actor: string;
  ip?: string | null;
}

/**
 * Tracks which devices currently hold a live socket (chat, later push delivery), so a revoke can
 * close the connection immediately instead of waiting for the device's next request to hit the
 * revoked token. Sockets register themselves through `add`, which returns the release function to
 * call on their own 'close' — the registry never listens for socket events itself.
 */
export class MobileSocketRegistry {
  private readonly byDevice = new Map<string, Set<WebSocket>>();
  private readonly byUser = new Map<string, Set<string>>();

  add(deviceId: string, ws: WebSocket, userId: string): () => void {
    let sockets = this.byDevice.get(deviceId);
    if (!sockets) {
      sockets = new Set();
      this.byDevice.set(deviceId, sockets);
    }
    sockets.add(ws);

    let devices = this.byUser.get(userId);
    if (!devices) {
      devices = new Set();
      this.byUser.set(userId, devices);
    }
    devices.add(deviceId);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const set = this.byDevice.get(deviceId);
      set?.delete(ws);
      if (set && set.size === 0) {
        this.byDevice.delete(deviceId);
        const userDevices = this.byUser.get(userId);
        userDevices?.delete(deviceId);
        if (userDevices && userDevices.size === 0) this.byUser.delete(userId);
      }
    };
  }

  /** Closes every live socket for a device; returns how many were closed. */
  closeDevice(deviceId: string, code: number, reason: string): number {
    const sockets = this.byDevice.get(deviceId);
    if (!sockets) return 0;
    const count = sockets.size;
    for (const ws of sockets) ws.close(code, reason);
    return count;
  }

  hasLive(deviceId: string): boolean {
    return (this.byDevice.get(deviceId)?.size ?? 0) > 0;
  }

  /** A snapshot, not a live view: safe for a caller to iterate while sockets close. */
  liveDevices(userId: string): Set<string> {
    return new Set(this.byUser.get(userId) ?? []);
  }
}

/**
 * Revokes a device. Today this only flips its status; Task 9 completes it with session/token
 * deletion, clearing the push token, recording the `device_revoked` event, closing any live
 * socket through `deps.sockets` and mailing the owner through `deps.mailer`.
 */
export async function revokeDevice(
  deps: { repos: Repositories; sockets: MobileSocketRegistry; mailer: Mailer },
  deviceId: string,
  input: RevokeInput,
): Promise<Device | undefined> {
  return deps.repos.devices.revoke(deviceId, input.reason, new Date());
}
