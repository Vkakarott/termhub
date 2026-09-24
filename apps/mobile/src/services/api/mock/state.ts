// The mock "server"'s in-memory rows (design spec §4.2) and the `verify()` helper shared by
// every authenticated route. Nothing here is persisted: a fresh `createMockState()` is a fresh
// server, which is the point (§4.2's closing paragraph — a stale device must behave like a
// revoked one, not like a 404).
import { sha256 } from '@noble/hashes/sha2.js';
import { b64url, utf8 } from '../../crypto/encoding';
import type { P256Jwk } from '../../key/types';
import { verifyProof } from '../dpop';
import type { TDeviceInfo } from '../contract';

/** Every non-2xx answer the mock throws (design spec ruling): mapped to the wire shape by
 * `transport.ts`. `error` is pt-BR text; `extra` carries `attempts_left` / `retry_after`, spread
 * into the body verbatim and mirrored onto a `Retry-After` header when `retry_after` is present. */
export class WireError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly error: string,
    readonly extra?: Record<string, unknown>
  ) {
    super(error);
    this.name = 'WireError';
  }
}

export type MockDeviceRequestStatus = 'pending' | 'approved' | 'denied' | 'activated';

export interface MockDeviceRequest {
  id: string;
  email: string;
  publicKey: P256Jwk;
  device: TDeviceInfo;
  appVersion: string;
  /** sha256 hex of the request secret — the secret itself is never stored (ruling 8). */
  secretHash: string;
  code: string;
  status: MockDeviceRequestStatus;
  createdAt: number;
  expiresAt: number;
  /** Set once `approve()` moves the row to `approved`; undefined before that. */
  activateUntil?: number;
}

export interface MockDevice {
  id: string;
  userId: string;
  email: string;
  jwk: P256Jwk;
  pinSecret: Uint8Array;
  pinFailures: number;
  lockedUntil?: number;
  status: 'active' | 'revoked';
  revokedReason?: string;
  pushToken?: string;
  name: string;
  platform: 'ios' | 'android';
  model: string;
  os: string;
  createdAt: number;
}

export interface MockToken {
  deviceId: string;
  expiresAt: number;
}

export interface MockChallenge {
  deviceId: string;
  purpose: 'refresh' | 'decision';
  actionId?: string;
  expiresAt: number;
  used: boolean;
}

/** A stand-in for Task 9's fake socket — this task only needs the type to exist so `sockets` and
 * `controls.dropSocket()` typecheck; nothing ever populates the set yet (ruling 1). */
export interface MockSocket {
  deviceId: string;
  close(code: number): void;
}

export interface MockState {
  requests: Map<string, MockDeviceRequest>;
  devices: Map<string, MockDevice>;
  tokens: Map<string, MockToken>;
  challenges: Map<string, MockChallenge>;
  /** Per-device jti window (P§5.2: replayed within 5 minutes is refused), value is the `iat`
   * (seconds) the jti was first seen at, used to prune entries older than the window. */
  jtis: Map<string, Map<string, number>>;
  sockets: Set<MockSocket>;
}

export function createMockState(): MockState {
  return {
    requests: new Map(),
    devices: new Map(),
    tokens: new Map(),
    challenges: new Map(),
    jtis: new Map(),
    sockets: new Set(),
  };
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** sha256 hex of a UTF-8 string — used to hash request secrets and access tokens for lookups
 * without ever keeping the clear value (ruling 8). */
export const sha256Hex = (s: string): string => toHex(sha256(utf8(s)));

export function bearerToken(headers: Record<string, string>): string | undefined {
  const auth = headers.authorization;
  if (!auth) return undefined;
  const m = /^Bearer (.+)$/.exec(auth);
  return m?.[1];
}

/** The externally-visible poll status (P§4.5): `denied`/`activated` and any expiry collapse to
 * `closed`, so a decoy and a real row are indistinguishable to whoever holds the secret. */
export function requestStatus(req: MockDeviceRequest, now: number): 'pending' | 'approved' | 'closed' {
  if (req.status === 'pending') return now > req.expiresAt ? 'closed' : 'pending';
  if (req.status === 'approved') return req.activateUntil !== undefined && now <= req.activateUntil ? 'approved' : 'closed';
  return 'closed';
}

/** Prunes jtis older than the 5-minute window, then claims `jti` for `deviceId` — returns `false`
 * on a replay (P§5.2). */
export function claimJti(state: MockState, deviceId: string, jti: string, nowSeconds: number): boolean {
  let bucket = state.jtis.get(deviceId);
  if (!bucket) {
    bucket = new Map();
    state.jtis.set(deviceId, bucket);
  }
  for (const [seenJti, seenAt] of bucket) {
    if (nowSeconds - seenAt > 300) bucket.delete(seenJti);
  }
  if (bucket.has(jti)) return false;
  bucket.set(jti, nowSeconds);
  return true;
}

export type VerifiedAuth = { device: MockDevice; token: string };

/**
 * The generic authenticated-route check (`me`, `devices/self`, `devices/self/revoke`,
 * `push-token`): bearer → token row, device (revoked or missing alike answer `DEVICE_REVOKED`),
 * DPoP (bound to the token's `ath`), then the jti window — in that order (brief ruling), unlike
 * `session/token`'s order where the signature is checked before the device's revoked status.
 */
export function verifyAuth(state: MockState, ctx: { headers: Record<string, string>; htm: string; htu: string; now: number }): VerifiedAuth {
  const bearer = bearerToken(ctx.headers);
  const tokenRow = bearer ? state.tokens.get(bearer) : undefined;
  if (!bearer || !tokenRow || tokenRow.expiresAt <= ctx.now) {
    throw new WireError(401, 'TOKEN_EXPIRED', 'Sessão expirada.');
  }

  const device = state.devices.get(tokenRow.deviceId);
  if (!device || device.status === 'revoked') {
    throw new WireError(401, 'DEVICE_REVOKED', 'Este aparelho foi removido da conta.');
  }

  const nowSeconds = Math.floor(ctx.now / 1000);
  const ath = b64url(sha256(utf8(bearer)));
  const dpop = ctx.headers.dpop;
  const result = dpop ? verifyProof(dpop, { htm: ctx.htm, htu: ctx.htu, now: nowSeconds, jwk: device.jwk, ath }) : undefined;
  if (!result || !result.ok) throw new WireError(401, 'PROOF_INVALID', 'Prova de posse inválida.');

  if (!claimJti(state, device.id, result.jti, nowSeconds)) {
    throw new WireError(401, 'PROOF_REPLAYED', 'Prova repetida.');
  }

  return { device, token: bearer };
}

/** Revokes one device: deletes its tokens and closes its (and only its) sockets with `4401`
 * (P§5.5, P§5.7). Shared by the brute-force lockout path and `controls.revokeNow`. */
export function revokeDevice(state: MockState, device: MockDevice, reason: string): void {
  device.status = 'revoked';
  device.revokedReason = reason;
  for (const [token, row] of state.tokens) {
    if (row.deviceId === device.id) state.tokens.delete(token);
  }
  for (const socket of state.sockets) {
    if (socket.deviceId === device.id) socket.close(4401);
  }
}
