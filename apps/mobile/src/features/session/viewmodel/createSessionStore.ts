// The session store (design spec §5): enrolment, PIN and activation, unlock and silent renewal,
// relock, biometrics, leaving and revocation. A factory over injected services so tests drive it
// against the mock transport; `useSessionStore.ts` builds the app's one instance.
//
// Secrets never enter the zustand state: the access token, the unwrapped `pin_secret` and the
// enrolment `request_secret` live in this closure only, so neither `persist` nor a devtools dump
// can ever see them (spec §5.1).
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { sessionEnded } from '@/features/shared/signals';
import { ApiError } from '@/services/api/errors';
import { b64url, fromB64url } from '@/services/crypto/encoding';
import { decisionProof, deriveWrapKey, PIN_RE, pinProof, unwrapSecret, wrapSecret } from '@/services/crypto/pin';
import { randomBytes } from '@/services/crypto/random';
import { mmkvStateStorage, resetPersistedStores } from '@/services/storage';
import { readDeviceInfo } from '../model/device-info';
import { persistablePhase, type SessionDeps, type SessionState } from '../model/session.types';

/** Relock after this long in the background (P§5.6). */
export const RELOCK_AFTER_MS = 5 * 60_000;

const MSG = {
  closed: 'O pedido expirou ou foi recusado. Tente de novo.',
  revoked: 'Este aparelho foi removido da sua conta.',
  locked: 'Aparelho bloqueado por tentativas de PIN.',
  pinInvalid: 'PIN incorreto.',
  pinFormat: 'O PIN tem 6 dígitos.',
  pinMismatch: 'Os dois PINs não são iguais.',
  usePin: 'Use o PIN.',
  biometricsOff: 'Não foi possível ativar a biometria.',
  network: 'Não foi possível falar com o servidor. Tente de novo.',
} as const;

type Data = Omit<SessionState, { [K in keyof SessionState]: SessionState[K] extends (...args: never[]) => unknown ? K : never }[keyof SessionState]>;

const initialData = (mockControls: SessionDeps['mockControls']): Data => ({
  phase: 'new',
  hydrated: false,
  deviceId: null,
  deviceName: null,
  email: null,
  biometricsEnabled: false,
  lastBackgroundAt: null,
  pendingRoute: null,
  request: null,
  lockedUntil: null,
  attemptsLeft: null,
  error: null,
  busy: false,
  notice: null,
  mockControls,
  pinPrompt: null,
});

const isApiError = (e: unknown, code: string): e is ApiError => e instanceof ApiError && e.code === code;

export function createSessionStore(deps: SessionDeps) {
  const { api, key, vault, mockControls } = deps;
  const now = deps.now ?? Date.now;

  // In memory only (spec §5.1).
  let accessToken: string | null = null;
  let pinSecret: Uint8Array | null = null;
  let requestSecret: string | null = null;

  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let renewing: Promise<string | null> | null = null;
  let prompt: { resolve(v: { challenge: string; pin_proof: string }): void; reject(e: Error): void } | null = null;

  const store = create<SessionState>()(
    persist(
      (set, get) => {
        // `set` for an early `return` from an action typed `Promise<void>` (zustand's `set` returns `unknown`).
        const patch = (partial: Partial<SessionState>): void => {
          set(partial);
        };

        const stopPolling = () => {
          if (pollTimer) clearTimeout(pollTimer);
          pollTimer = null;
        };

        const dropPrompt = () => {
          prompt?.reject(new Error('CANCELLED'));
          prompt = null;
          set({ pinPrompt: null });
        };

        /** `unlocked` → `locked` without touching the vault (spec §5.4). */
        const relock = () => {
          accessToken = null;
          pinSecret = null;
          dropPrompt();
          set({ phase: 'locked' });
        };

        /** A new session (activation or unlock): the token, `unlocked`, and one push-token
         * registration — fire-and-forget, it must never block the flow (P§9). */
        const startSession = (token: string, secret: Uint8Array) => {
          accessToken = token;
          pinSecret = secret;
          set({ phase: 'unlocked', lockedUntil: null, attemptsLeft: null, error: null, busy: false });
          const deviceId = get().deviceId;
          api.setPushToken({ accessToken: token }, `ExponentPushToken[mock-${deviceId}]`).catch(() => undefined);
        };

        /** The shared reaction to a failed action (ruling 8). */
        const fail = async (e: unknown) => {
          if (isApiError(e, 'DEVICE_REVOKED')) return get().wipe(MSG.revoked);
          if (isApiError(e, 'DEVICE_LOCKED')) {
            accessToken = null;
            pinSecret = null;
            set({
              phase: 'locked',
              lockedUntil: new Date(now() + (e.retryAfter ?? 0) * 1000).toISOString(),
              attemptsLeft: null,
              error: MSG.locked,
              busy: false,
            });
            return;
          }
          if (isApiError(e, 'PIN_INVALID')) {
            set({ error: MSG.pinInvalid, attemptsLeft: e.attemptsLeft ?? null, busy: false });
            return;
          }
          set({ error: e instanceof ApiError ? e.message : MSG.network, busy: false });
        };

        /** The PIN never gets compared here: any PIN unwraps to 32 plausible bytes (P§5.4). A vault
         * missing its items is a half session, which only a wipe can end. */
        const unwrapWithPin = async (pin: string): Promise<Uint8Array | null> => {
          const [wrapped, salt, deviceId] = await Promise.all([vault.get('pin.wrapped'), vault.get('pin.salt'), vault.get('device.id')]);
          if (!wrapped || !salt || !deviceId || deviceId !== get().deviceId) return null;
          return unwrapSecret(fromB64url(wrapped), await deriveWrapKey(pin, fromB64url(salt)));
        };

        const readBiometricSecret = async (): Promise<Uint8Array | null> => {
          try {
            const s = await vault.get('pin.biometric', true);
            return s ? fromB64url(s) : null;
          } catch {
            return null;
          }
        };

        /** `challenge` + `token` for a candidate secret, kept only once the server accepts it. */
        const redeem = async (candidate: Uint8Array) => {
          const deviceId = get().deviceId!;
          const { challenge } = await api.challenge({ device_id: deviceId, purpose: 'refresh' });
          const res = await api.token({ device_id: deviceId, challenge, pin_proof: pinProof(candidate, challenge) });
          startSession(res.access_token, candidate);
        };

        const schedulePoll = (id: string, after: number) => {
          pollTimer = setTimeout(async () => {
            pollTimer = null;
            if (get().request?.id !== id || !requestSecret) return;
            let status: 'pending' | 'approved' | 'closed' = 'pending';
            try {
              status = (await api.pollRequest(id, requestSecret)).status;
            } catch {
              // a transient failure: keep polling, the server's `closed` ends it eventually
            }
            if (get().request?.id !== id) return; // cancelled while in flight
            if (status === 'approved') set({ phase: 'pin_setup' });
            else if (status === 'closed') {
              requestSecret = null;
              set({ phase: 'new', request: null, notice: MSG.closed });
            } else schedulePoll(id, after);
          }, after);
        };

        return {
          ...initialData(mockControls),

          async requestDevice(email) {
            stopPolling();
            set({ busy: true, error: null, notice: null });
            try {
              const publicKey = await key.create();
              const info = readDeviceInfo();
              const res = await api.requestDevice({ email, public_key: publicKey, ...info });
              requestSecret = res.request_secret;
              set({
                phase: 'waiting',
                request: { id: res.request_id, code: res.verification_code, expiresAt: res.expires_at },
                email: email.trim().toLowerCase(),
                deviceName: info.device.name,
                busy: false,
              });
              schedulePoll(res.request_id, res.poll_after);
            } catch (e) {
              await fail(e);
            }
          },

          cancelRequest() {
            stopPolling();
            requestSecret = null;
            set({ phase: 'new', request: null, busy: false, error: null });
          },

          async createPin(pin, confirm) {
            if (!PIN_RE.test(pin)) return patch({ error: MSG.pinFormat });
            if (pin !== confirm) return patch({ error: MSG.pinMismatch });
            const request = get().request;
            if (get().phase !== 'pin_setup' || !request || !requestSecret) return;
            set({ busy: true, error: null });
            try {
              const res = await api.activate({ request_id: request.id, request_secret: requestSecret });
              const secret = fromB64url(res.pin_secret);
              const salt = randomBytes(16);
              const wrapped = wrapSecret(secret, await deriveWrapKey(pin, salt));
              await vault.set('pin.wrapped', b64url(wrapped));
              await vault.set('pin.salt', b64url(salt));
              await vault.set('device.id', res.device_id);
              requestSecret = null;
              set({ deviceId: res.device_id, request: null });
              startSession(res.access_token, secret);
            } catch (e) {
              if (isApiError(e, 'REQUEST_INVALID')) {
                requestSecret = null;
                set({ phase: 'new', request: null, busy: false, notice: MSG.closed });
                return;
              }
              await fail(e);
            }
          },

          async unlock(pin) {
            if (!PIN_RE.test(pin)) return patch({ error: MSG.pinFormat });
            set({ busy: true, error: null });
            try {
              const candidate = await unwrapWithPin(pin);
              if (!candidate) return get().wipe();
              await redeem(candidate);
            } catch (e) {
              await fail(e);
            }
          },

          async unlockWithBiometrics() {
            set({ busy: true, error: null });
            const secret = await readBiometricSecret();
            if (!secret) return patch({ busy: false, error: MSG.usePin });
            try {
              await redeem(secret);
            } catch (e) {
              if (isApiError(e, 'DEVICE_REVOKED') || isApiError(e, 'DEVICE_LOCKED')) return fail(e);
              set({ busy: false, error: MSG.usePin });
            }
          },

          async enableBiometrics() {
            const secret = pinSecret;
            if (!secret || !deps.localAuth) return false;
            try {
              if (!(await deps.localAuth.available()) || !(await deps.localAuth.authenticate())) {
                set({ error: MSG.biometricsOff });
                return false;
              }
              await vault.set('pin.biometric', b64url(secret), { biometric: true });
              set({ biometricsEnabled: true, error: null });
              return true;
            } catch {
              set({ error: MSG.biometricsOff });
              return false;
            }
          },

          async disableBiometrics() {
            await vault.delete('pin.biometric').catch(() => undefined);
            set({ biometricsEnabled: false });
          },

          renewToken() {
            if (renewing) return renewing;
            const secret = pinSecret;
            const deviceId = get().deviceId;
            if (!secret || !deviceId) {
              if (get().phase === 'unlocked') relock();
              return Promise.resolve(null);
            }
            renewing = (async () => {
              try {
                const { challenge } = await api.challenge({ device_id: deviceId, purpose: 'refresh' });
                const res = await api.token({ device_id: deviceId, challenge, pin_proof: pinProof(secret, challenge) });
                accessToken = res.access_token;
                return accessToken;
              } catch (e) {
                if (isApiError(e, 'DEVICE_REVOKED') || isApiError(e, 'DEVICE_LOCKED')) await fail(e);
                else if (isApiError(e, 'PIN_INVALID')) relock();
                return null;
              } finally {
                renewing = null;
              }
            })();
            return renewing;
          },

          auth() {
            if (!accessToken) throw new Error('LOCKED');
            return { accessToken };
          },

          requestPinProof(actionId) {
            dropPrompt();
            return new Promise((resolve, reject) => {
              prompt = { resolve, reject };
              set({ pinPrompt: { actionId }, error: null });
            });
          },

          async resolvePinPrompt(pin) {
            const actionId = get().pinPrompt?.actionId;
            if (!prompt || !actionId) return;
            if (pin !== 'biometrics' && !PIN_RE.test(pin)) return patch({ error: MSG.pinFormat });
            set({ busy: true, error: null });
            try {
              const secret = pin === 'biometrics' ? await readBiometricSecret() : await unwrapWithPin(pin);
              if (!secret) return patch({ busy: false, error: MSG.usePin });
              const { challenge } = await api.challenge({ device_id: get().deviceId!, purpose: 'decision', action_id: actionId });
              const answer = { challenge, pin_proof: decisionProof(secret, challenge, actionId) };
              const waiting = prompt;
              prompt = null;
              set({ pinPrompt: null, busy: false });
              waiting?.resolve(answer);
            } catch (e) {
              await fail(e);
            }
          },

          cancelPinPrompt() {
            dropPrompt();
          },

          background() {
            set({ lastBackgroundAt: now() });
          },

          foreground() {
            const since = get().lastBackgroundAt;
            set({ lastBackgroundAt: null });
            if (get().phase === 'unlocked' && since !== null && now() - since >= RELOCK_AFTER_MS) relock();
          },

          async leave() {
            set({ busy: true });
            if (accessToken) await api.revokeSelf({ accessToken }).catch(() => undefined);
            await get().wipe();
          },

          async wipe(reason) {
            stopPolling();
            dropPrompt();
            accessToken = null;
            pinSecret = null;
            requestSecret = null;
            await vault.clear().catch(() => undefined);
            await key.destroy().catch(() => undefined);
            resetPersistedStores();
            sessionEnded.emit();
            set({ ...initialData(mockControls), hydrated: true, notice: reason ?? null });
          },
        };
      },
      {
        name: 'session',
        storage: createJSONStorage(() => mmkvStateStorage),
        partialize: (s) => ({
          phase: persistablePhase(s.phase),
          deviceId: s.deviceId,
          deviceName: s.deviceName,
          email: s.email,
          biometricsEnabled: s.biometricsEnabled,
          lastBackgroundAt: s.lastBackgroundAt,
        }),
      },
    ),
  );

  const markHydrated = () => store.setState({ hydrated: true });
  store.persist.onFinishHydration(markHydrated);
  if (store.persist.hasHydrated()) markHydrated();
  return store;
}
