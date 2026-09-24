// The session store (design spec §5) driven over the real `HttpMobileApi` and the in-memory
// `MockTransport`, with the SecureStore / MMKV fakes of the `logic` project underneath.
import * as SecureStore from 'expo-secure-store';
import { sessionEnded } from '@/features/shared/signals';
import { createHttpMobileApi } from '@/services/api/client';
import { ApiError } from '@/services/api/errors';
import { createMockTransport } from '@/services/api/mock';
import { fromB64url } from '@/services/crypto/encoding';
import { decisionProof } from '@/services/crypto/pin';
import { SoftwareDeviceKey } from '@/services/key/software';
import { mmkv } from '@/services/storage';
import { vault } from '@/services/vault';
import { createSessionStore } from './createSessionStore';

const START = Date.parse('2026-09-24T12:00:00Z');
const PIN = '123456';
// Captured before any test installs fake timers: drains every pending microtask (a `void`-started wipe).
const realSetImmediate = setImmediate;
const flush = () => new Promise<void>((resolve) => realSetImmediate(() => resolve()));
const secureItems = (SecureStore as unknown as { __items: Map<string, string> }).__items;

type Store = ReturnType<typeof createSessionStore>;

function setup() {
  const clock = { value: START };
  const now = () => clock.value;
  const transport = createMockTransport({ latency: [0, 0], now });
  const key = new SoftwareDeviceKey();
  let store: Store | null = null;
  const api = createHttpMobileApi({
    transport,
    baseUrl: 'https://termhub.dev',
    app: 'ios/0.1.0+1',
    key,
    onTokenExpired: () => store!.getState().renewToken(),
    now,
  });
  const localAuth = { available: jest.fn(async () => true), authenticate: jest.fn(async () => true) };
  const make = () => createSessionStore({ api, key, vault, now, mockControls: transport.controls, localAuth });
  store = make();
  return { clock, transport, controls: transport.controls, api, key, localAuth, store, make };
}

/** requestDevice → approve → one poll → createPin: leaves the store `unlocked`, and returns the
 * `pin_secret` the mock handed out (captured from `activate`) so a test can check where it went. */
async function enrol(ctx: ReturnType<typeof setup>, pin = PIN): Promise<string> {
  let pinSecret = '';
  const activate = ctx.api.activate.bind(ctx.api);
  const spy = jest.spyOn(ctx.api, 'activate').mockImplementation(async (body) => {
    const res = await activate(body);
    pinSecret = res.pin_secret;
    return res;
  });
  await ctx.store.getState().requestDevice('pedro@x.com');
  const [id] = ctx.controls.pendingRequestIds();
  ctx.controls.approve(id!);
  await jest.advanceTimersByTimeAsync(2000);
  expect(ctx.store.getState().phase).toBe('pin_setup');
  await ctx.store.getState().createPin(pin, pin);
  expect(ctx.store.getState().phase).toBe('unlocked');
  spy.mockRestore();
  return pinSecret;
}

function mmkvValues(): string[] {
  return mmkv.getAllKeys().map((k) => mmkv.getString(k) ?? '');
}

beforeEach(() => {
  jest.useFakeTimers();
  mmkv.clearAll();
  secureItems.clear();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('requests a device and waits', async () => {
  const ctx = setup();
  const poll = jest.spyOn(ctx.api, 'pollRequest');
  await ctx.store.getState().requestDevice('pedro@x.com');

  const s = ctx.store.getState();
  expect(s.phase).toBe('waiting');
  expect(s.request?.code).toHaveLength(6);
  expect(s.email).toBe('pedro@x.com');
  expect(s.deviceName).toBe('iPhone de teste');
  expect(poll).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(2000);
  expect(poll).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(2000);
  expect(poll).toHaveBeenCalledTimes(2);
  expect(ctx.store.getState().phase).toBe('waiting');

  ctx.controls.approve(ctx.controls.pendingRequestIds()[0]!);
  await jest.advanceTimersByTimeAsync(2000);
  expect(poll).toHaveBeenCalledTimes(3);
  expect(ctx.store.getState().phase).toBe('pin_setup');

  // approval stops the polling
  await jest.advanceTimersByTimeAsync(10_000);
  expect(poll).toHaveBeenCalledTimes(3);
});

it('cancelRequest stops the polling and goes back to new', async () => {
  const ctx = setup();
  const poll = jest.spyOn(ctx.api, 'pollRequest');
  await ctx.store.getState().requestDevice('pedro@x.com');
  ctx.store.getState().cancelRequest();
  await jest.advanceTimersByTimeAsync(10_000);
  expect(poll).not.toHaveBeenCalled();
  expect(ctx.store.getState()).toMatchObject({ phase: 'new', request: null });
});

it('a denied request goes back to new with a notice', async () => {
  const ctx = setup();
  const poll = jest.spyOn(ctx.api, 'pollRequest');
  await ctx.store.getState().requestDevice('pedro@x.com');
  ctx.controls.deny(ctx.controls.pendingRequestIds()[0]!);
  await jest.advanceTimersByTimeAsync(2000);

  expect(ctx.store.getState()).toMatchObject({
    phase: 'new',
    request: null,
    notice: 'O pedido expirou ou foi recusado. Tente de novo.',
  });
  await jest.advanceTimersByTimeAsync(10_000);
  expect(poll).toHaveBeenCalledTimes(1);
});

it('createPin refuses a mismatch and a non-6-digit PIN without calling the API', async () => {
  const ctx = setup();
  await ctx.store.getState().requestDevice('pedro@x.com');
  ctx.controls.approve(ctx.controls.pendingRequestIds()[0]!);
  await jest.advanceTimersByTimeAsync(2000);
  const activate = jest.spyOn(ctx.api, 'activate');

  await ctx.store.getState().createPin('123456', '654321');
  expect(ctx.store.getState().error).toBe('Os dois PINs não são iguais.');
  await ctx.store.getState().createPin('12345', '12345');
  expect(ctx.store.getState().error).toBe('O PIN tem 6 dígitos.');
  await ctx.store.getState().createPin('12a456', '12a456');
  expect(ctx.store.getState().error).toBe('O PIN tem 6 dígitos.');

  expect(activate).not.toHaveBeenCalled();
  expect(ctx.store.getState().phase).toBe('pin_setup');
});

it('activation wraps the secret: vault has pin.wrapped, pin.salt, device.id; MMKV never contains the secret or token', async () => {
  const ctx = setup();
  const secret = await enrol(ctx);
  const s = ctx.store.getState();

  expect(s.deviceId).toEqual(expect.any(String));
  expect(await vault.get('device.id')).toBe(s.deviceId);
  expect(await vault.get('pin.wrapped')).toEqual(expect.any(String));
  expect(await vault.get('pin.wrapped')).not.toBe(secret);
  expect(fromB64url((await vault.get('pin.salt'))!)).toHaveLength(16);
  expect(await vault.get('pin.biometric')).toBeNull();

  const token = s.auth().accessToken;
  expect(token).toEqual(expect.any(String));
  const values = mmkvValues();
  expect(values.length).toBeGreaterThan(0);
  for (const v of values) {
    expect(v).not.toContain(secret);
    expect(v).not.toContain(token);
  }
  for (const v of secureItems.values()) expect(v).not.toContain(token);
  expect(JSON.parse(mmkv.getString('session')!).state).toEqual({
    phase: 'locked',
    deviceId: s.deviceId,
    deviceName: 'iPhone de teste',
    email: 'pedro@x.com',
    biometricsEnabled: false,
    lastBackgroundAt: null,
  });
});

it('waiting and pin_setup do not survive a restart', async () => {
  const ctx = setup();
  await ctx.store.getState().requestDevice('pedro@x.com');
  expect(ctx.make().getState()).toMatchObject({ phase: 'new', hydrated: true, request: null });

  ctx.controls.approve(ctx.controls.pendingRequestIds()[0]!);
  await jest.advanceTimersByTimeAsync(2000);
  expect(ctx.store.getState().phase).toBe('pin_setup');
  expect(ctx.make().getState().phase).toBe('new');

  await ctx.store.getState().createPin(PIN, PIN);
  expect(ctx.store.getState().phase).toBe('unlocked');
  // a cold start is `unlocked` persisting as `locked`, with no token in memory
  const restarted = ctx.make();
  expect(restarted.getState()).toMatchObject({ phase: 'locked', deviceId: ctx.store.getState().deviceId, email: 'pedro@x.com' });
  expect(() => restarted.getState().auth()).toThrow('LOCKED');
});

it('unlock with a wrong PIN says PIN incorreto with attempts left; three make it locked with lockedUntil; the right PIN after the lock unlocks', async () => {
  const ctx = setup();
  await enrol(ctx);
  const store = ctx.make(); // cold start → locked
  expect(store.getState().phase).toBe('locked');

  for (const left of [2, 1, 0]) {
    await store.getState().unlock('000000');
    expect(store.getState()).toMatchObject({ phase: 'locked', error: 'PIN incorreto.', attemptsLeft: left, busy: false });
  }
  // The third failure sets the lock on the server; the next attempt — even the right PIN — sees 423.
  await store.getState().unlock(PIN);
  expect(store.getState()).toMatchObject({
    phase: 'locked',
    error: 'Aparelho bloqueado por tentativas de PIN.',
    lockedUntil: new Date(ctx.clock.value + 900_000).toISOString(),
  });
  expect(() => store.getState().auth()).toThrow('LOCKED');

  ctx.clock.value += 15 * 60_000 + 1;
  await store.getState().unlock(PIN);
  expect(store.getState()).toMatchObject({ phase: 'unlocked', error: null, lockedUntil: null, attemptsLeft: null });
  expect(store.getState().auth().accessToken).toEqual(expect.any(String));
});

it('unlock never calls the API for a PIN that is not six digits', async () => {
  const ctx = setup();
  await enrol(ctx);
  const store = ctx.make();
  const challenge = jest.spyOn(ctx.api, 'challenge');
  await store.getState().unlock('12');
  expect(challenge).not.toHaveBeenCalled();
  expect(store.getState()).toMatchObject({ phase: 'locked', error: 'O PIN tem 6 dígitos.' });
});

it('background for 5 min then foreground relocks; 4 min does not', async () => {
  const ctx = setup();
  await enrol(ctx);
  const { store } = ctx;

  store.getState().background();
  expect(store.getState().lastBackgroundAt).toBe(ctx.clock.value);
  ctx.clock.value += 4 * 60_000;
  store.getState().foreground();
  expect(store.getState().phase).toBe('unlocked');
  expect(store.getState().auth().accessToken).toEqual(expect.any(String));

  store.getState().background();
  ctx.clock.value += 5 * 60_000;
  store.getState().foreground();
  expect(store.getState().phase).toBe('locked');
  expect(() => store.getState().auth()).toThrow('LOCKED');
  // the relock never touches the vault
  expect(await vault.get('pin.wrapped')).toEqual(expect.any(String));
  // and the in-memory secret is gone: renewal cannot happen silently
  expect(await store.getState().renewToken()).toBeNull();
});

it('renewToken is single-flighted and returns null when locked', async () => {
  const ctx = setup();
  await enrol(ctx);
  const { store } = ctx;
  const before = store.getState().auth().accessToken;
  const challenge = jest.spyOn(ctx.api, 'challenge');
  const token = jest.spyOn(ctx.api, 'token');

  const [a, b] = await Promise.all([store.getState().renewToken(), store.getState().renewToken()]);
  expect(a).toEqual(expect.any(String));
  expect(b).toBe(a);
  expect(a).not.toBe(before);
  expect(challenge).toHaveBeenCalledTimes(1);
  expect(token).toHaveBeenCalledTimes(1);
  expect(store.getState().auth().accessToken).toBe(a);
  expect(store.getState().phase).toBe('unlocked');

  // An expired token on any call is renewed silently through the client's renewer.
  ctx.clock.value += 16 * 60_000;
  const me = await ctx.api.me(store.getState().auth());
  expect(me.device.id).toBe(store.getState().deviceId);
  expect(challenge).toHaveBeenCalledTimes(2);

  // after a cold start the secret is not in memory: null and locked, no API call
  const cold = ctx.make();
  expect(await cold.getState().renewToken()).toBeNull();
  expect(cold.getState().phase).toBe('locked');
  expect(challenge).toHaveBeenCalledTimes(2);
});

it('requestPinProof resolves when the prompt is answered with the right PIN and rejects on cancel', async () => {
  const ctx = setup();
  const secret = fromB64url(await enrol(ctx));
  const { store } = ctx;
  const challenge = jest.spyOn(ctx.api, 'challenge');

  const pending = store.getState().requestPinProof('act-1');
  expect(store.getState().pinPrompt).toEqual({ actionId: 'act-1' });
  await store.getState().resolvePinPrompt(PIN);
  const proof = await pending;
  expect(challenge).toHaveBeenCalledWith({ device_id: store.getState().deviceId, purpose: 'decision', action_id: 'act-1' });
  expect(proof.pin_proof).toBe(decisionProof(secret, proof.challenge, 'act-1'));
  expect(store.getState().pinPrompt).toBeNull();

  const cancelled = store.getState().requestPinProof('act-2');
  store.getState().cancelPinPrompt();
  await expect(cancelled).rejects.toThrow('CANCELLED');
  expect(store.getState().pinPrompt).toBeNull();
});

it('leave revokes and wipes: vault empty, phase new; a DEVICE_REVOKED from any call wipes too', async () => {
  const ended = jest.fn();
  const unsubscribe = sessionEnded.subscribe(ended);
  try {
    const ctx = setup();
    await enrol(ctx);
    const revoke = jest.spyOn(ctx.api, 'revokeSelf');
    await ctx.store.getState().leave();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(secureItems.size).toBe(0);
    expect(ctx.store.getState()).toMatchObject({ phase: 'new', deviceId: null, email: null, notice: null });
    expect(() => ctx.store.getState().auth()).toThrow('LOCKED');
    expect(ended).toHaveBeenCalledTimes(1);

    const ctx2 = setup();
    await enrol(ctx2);
    ctx2.controls.revokeNow();
    // the token is gone: the client renews, and the renewal meets DEVICE_REVOKED
    await expect(ctx2.api.me(ctx2.store.getState().auth())).rejects.toBeInstanceOf(ApiError);
    expect(secureItems.size).toBe(0);
    expect(ctx2.store.getState()).toMatchObject({ phase: 'new', notice: 'Este aparelho foi removido da sua conta.' });
    expect(ended).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
  }
});

it('a DEVICE_REVOKED during unlock wipes', async () => {
  const ctx = setup();
  await enrol(ctx);
  ctx.controls.revokeNow();
  const store = ctx.make();
  await store.getState().unlock(PIN);
  expect(store.getState()).toMatchObject({ phase: 'new', deviceId: null, notice: 'Este aparelho foi removido da sua conta.' });
  expect(secureItems.size).toBe(0);
});

it('enableBiometrics stores the plain secret behind biometrics and unlockWithBiometrics uses it', async () => {
  const ctx = setup();
  const secret = await enrol(ctx);
  const set = jest.spyOn(vault, 'set');

  expect(await ctx.store.getState().enableBiometrics()).toBe(true);
  expect(ctx.localAuth.available).toHaveBeenCalled();
  expect(ctx.localAuth.authenticate).toHaveBeenCalled();
  expect(set).toHaveBeenCalledWith('pin.biometric', secret, { biometric: true });
  expect(ctx.store.getState().biometricsEnabled).toBe(true);

  const store = ctx.make(); // cold start keeps the flag, drops the secret
  expect(store.getState()).toMatchObject({ phase: 'locked', biometricsEnabled: true });
  const get = jest.spyOn(vault, 'get');
  await store.getState().unlockWithBiometrics();
  expect(get).toHaveBeenCalledWith('pin.biometric', true);
  expect(store.getState().phase).toBe('unlocked');

  // any failure falls back to the PIN
  await store.getState().disableBiometrics();
  expect(await vault.get('pin.biometric')).toBeNull();
  expect(store.getState().biometricsEnabled).toBe(false);
  const again = ctx.make();
  await again.getState().unlockWithBiometrics();
  expect(again.getState()).toMatchObject({ phase: 'locked', error: 'Use o PIN.' });

  // a refused OS prompt does not enable anything
  ctx.localAuth.authenticate.mockResolvedValueOnce(false);
  expect(await store.getState().enableBiometrics()).toBe(false);
  expect(store.getState().biometricsEnabled).toBe(false);
  expect(await vault.get('pin.biometric')).toBeNull();
});

it('after activation and after every unlock, setPushToken is called once with a fake Expo token', async () => {
  const ctx = setup();
  const push = jest.spyOn(ctx.api, 'setPushToken');
  await enrol(ctx);
  const deviceId = ctx.store.getState().deviceId;
  await Promise.resolve();
  expect(push).toHaveBeenCalledTimes(1);
  expect(push).toHaveBeenLastCalledWith({ accessToken: expect.any(String) }, `ExponentPushToken[mock-${deviceId}]`);

  // a silent renewal is not a session start
  await ctx.store.getState().renewToken();
  expect(push).toHaveBeenCalledTimes(1);

  const store = ctx.make();
  await store.getState().unlock(PIN);
  expect(push).toHaveBeenCalledTimes(2);
  expect(push).toHaveBeenLastCalledWith({ accessToken: store.getState().auth().accessToken }, `ExponentPushToken[mock-${deviceId}]`);

  // a failing push registration never blocks the flow
  push.mockRejectedValueOnce(new Error('offline'));
  const third = ctx.make();
  await third.getState().unlock(PIN);
  expect(third.getState().phase).toBe('unlocked');
  expect(push).toHaveBeenCalledTimes(3);
});

describe('guards', () => {
  it('a relock during an in-flight renewal does not bring the token back', async () => {
    const ctx = setup();
    await enrol(ctx);
    const { store } = ctx;
    const challenge = ctx.api.challenge.bind(ctx.api);
    jest.spyOn(ctx.api, 'challenge').mockImplementation(async (body) => {
      // the app comes back after 5 min while the renewal is waiting on the server
      store.getState().background();
      ctx.clock.value += 5 * 60_000;
      store.getState().foreground();
      return challenge(body);
    });
    expect(await store.getState().renewToken()).toBeNull();
    expect(store.getState().phase).toBe('locked');
    expect(() => store.getState().auth()).toThrow('LOCKED');
  });

  it('a wipe during unlock does not unlock a wiped session', async () => {
    const ctx = setup();
    await enrol(ctx);
    const store = ctx.make();
    const token = ctx.api.token.bind(ctx.api);
    jest.spyOn(ctx.api, 'token').mockImplementation(async (body) => {
      // the server accepted the PIN, but the session was wiped before the answer landed
      const res = await token(body);
      await store.getState().wipe();
      return res;
    });
    await store.getState().unlock(PIN);
    expect(store.getState()).toMatchObject({ phase: 'new', deviceId: null, busy: false });
    expect(() => store.getState().auth()).toThrow('LOCKED');
  });

  it("a newer requestPinProof is not resolved by the previous prompt's answer", async () => {
    const ctx = setup();
    const secret = fromB64url(await enrol(ctx));
    const { store } = ctx;
    const a = store.getState().requestPinProof('act-A');
    let b: Promise<{ challenge: string; pin_proof: string }> | null = null;
    const challenge = ctx.api.challenge.bind(ctx.api);
    jest.spyOn(ctx.api, 'challenge').mockImplementationOnce(async (body) => {
      b = store.getState().requestPinProof('act-B');
      return challenge(body);
    });
    await store.getState().resolvePinPrompt(PIN);
    await expect(a).rejects.toThrow('CANCELLED');
    expect(store.getState()).toMatchObject({ pinPrompt: { actionId: 'act-B' }, busy: false });

    await store.getState().resolvePinPrompt(PIN);
    const proof = await b!;
    expect(proof.pin_proof).toBe(decisionProof(secret, proof.challenge, 'act-B'));
    expect(store.getState().pinPrompt).toBeNull();
  });

  it('a 423 during resolvePinPrompt rejects the pending promise and clears pinPrompt', async () => {
    const ctx = setup();
    await enrol(ctx);
    const { store } = ctx;
    const pending = store.getState().requestPinProof('act-1');
    jest.spyOn(ctx.api, 'challenge').mockRejectedValueOnce(new ApiError(423, 'DEVICE_LOCKED', 'x', 900));
    await store.getState().resolvePinPrompt(PIN);
    await expect(pending).rejects.toThrow('CANCELLED');
    expect(store.getState()).toMatchObject({
      pinPrompt: null,
      phase: 'locked',
      busy: false,
      error: 'Aparelho bloqueado por tentativas de PIN.',
      lockedUntil: new Date(ctx.clock.value + 900_000).toISOString(),
    });
  });

  it('a double tap on unlock spends one attempt', async () => {
    const ctx = setup();
    await enrol(ctx);
    const store = ctx.make();
    const token = jest.spyOn(ctx.api, 'token');
    await Promise.all([store.getState().unlock('000000'), store.getState().unlock('000000')]);
    expect(token).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ error: 'PIN incorreto.', attemptsLeft: 2, busy: false });
  });

  it('a double tap on createPin activates once and stays enrolled', async () => {
    const ctx = setup();
    await ctx.store.getState().requestDevice('pedro@x.com');
    ctx.controls.approve(ctx.controls.pendingRequestIds()[0]!);
    await jest.advanceTimersByTimeAsync(2000);
    const activate = jest.spyOn(ctx.api, 'activate');
    await Promise.all([ctx.store.getState().createPin(PIN, PIN), ctx.store.getState().createPin(PIN, PIN)]);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({ phase: 'unlocked', notice: null });
  });

  it('a local failure after activation revokes the new device and wipes', async () => {
    const ctx = setup();
    await ctx.store.getState().requestDevice('pedro@x.com');
    ctx.controls.approve(ctx.controls.pendingRequestIds()[0]!);
    await jest.advanceTimersByTimeAsync(2000);
    const revoke = jest.spyOn(ctx.api, 'revokeSelf');
    jest.spyOn(vault, 'set').mockRejectedValueOnce(new Error('keychain'));
    await ctx.store.getState().createPin(PIN, PIN);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(ctx.store.getState()).toMatchObject({
      phase: 'new',
      deviceId: null,
      busy: false,
      notice: 'Não foi possível guardar o PIN neste aparelho. Tente de novo.',
    });
    expect(secureItems.size).toBe(0);
  });

  it('handleApiError consumes DEVICE_REVOKED, DEVICE_LOCKED and PIN_INVALID, and nothing else', async () => {
    const ctx = setup();
    await enrol(ctx);
    const { store } = ctx;
    const pending = store.getState().requestPinProof('act-1');

    expect(store.getState().handleApiError(new ApiError(401, 'PIN_INVALID', 'x', undefined, 1))).toBe(true);
    expect(store.getState()).toMatchObject({ phase: 'unlocked', error: 'PIN incorreto.', attemptsLeft: 1 });

    expect(store.getState().handleApiError(new ApiError(423, 'DEVICE_LOCKED', 'x', 60))).toBe(true);
    expect(store.getState()).toMatchObject({
      phase: 'locked',
      pinPrompt: null,
      error: 'Aparelho bloqueado por tentativas de PIN.',
      lockedUntil: new Date(ctx.clock.value + 60_000).toISOString(),
    });
    expect(() => store.getState().auth()).toThrow('LOCKED');
    await expect(pending).rejects.toThrow('CANCELLED');

    expect(store.getState().handleApiError(new ApiError(500, 'HTTP_500', 'x'))).toBe(false);
    expect(store.getState().handleApiError(new Error('offline'))).toBe(false);
    expect(store.getState().phase).toBe('locked');

    expect(store.getState().handleApiError(new ApiError(401, 'DEVICE_REVOKED', 'x'))).toBe(true);
    await flush();
    expect(store.getState()).toMatchObject({ phase: 'new', deviceId: null, notice: 'Este aparelho foi removido da sua conta.' });
    expect(secureItems.size).toBe(0);
  });

  it('relock and wipe make the client forget its renewed token', async () => {
    const ctx = setup();
    await enrol(ctx);
    const forget = jest.spyOn(ctx.api, 'forgetTokens');
    ctx.store.getState().background();
    ctx.clock.value += 5 * 60_000;
    ctx.store.getState().foreground();
    expect(forget).toHaveBeenCalledTimes(1);
    await ctx.store.getState().wipe();
    expect(forget).toHaveBeenCalledTimes(2);
  });
});
