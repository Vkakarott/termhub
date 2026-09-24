// The settings store (design spec §7): only `device` — biometrics, the host and the theme each
// live in their own store (session, chat, theme). Driven over the real `HttpMobileApi` +
// `MockTransport` with an enrolled session, same as the other feature stores' tests.
import { sessionEnded } from '@/features/shared/signals';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createSettingsStore } from './createSettingsStore';

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  const store = createSettingsStore({ api: ctx.api, session: () => ctx.store.getState() });
  return { ...ctx, store };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('carries the api mode, for the Versão section', async () => {
  const { store, api } = await setup();
  expect(store.getState().mode).toBe(api.mode);
  expect(store.getState().server).toBe('Servidor: mock');

  // http mode names the configured server's host (TERMHUB_URL by default, injected here)
  const http = setupSession(undefined, 'http');
  const httpStore = createSettingsStore({ api: http.api, session: () => http.store.getState(), baseUrl: 'https://staging.termhub.dev' });
  expect(httpStore.getState()).toMatchObject({ mode: 'http', server: 'Servidor: staging.termhub.dev' });
  expect(createSettingsStore({ api: http.api, session: () => http.store.getState() }).getState().server).toBe('Servidor: termhub.dev');
});

it('loadDevice() fills the device from the API', async () => {
  const { store } = await setup();
  expect(store.getState().device).toBeNull();

  await store.getState().loadDevice();

  expect(store.getState().device).toMatchObject({ platform: 'ios', model: expect.any(String) });
  expect(store.getState().loadingDevice).toBe(false);
});

it('resets on sessionEnded', async () => {
  const { store } = await setup();
  await store.getState().loadDevice();
  expect(store.getState().device).not.toBeNull();

  sessionEnded.emit();

  expect(store.getState().device).toBeNull();
});
