import { mmkv } from '@/services/storage';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createProgressStore, PROGRESS_POLL_MS } from './createProgressStore';

/** `ctx.store` is the session store; the store under test is `progress`. */
async function setup(handleApiError?: (err: unknown) => boolean) {
  const ctx = setupSession();
  await enrol(ctx);
  const session = () => {
    const s = ctx.store.getState();
    return handleApiError ? { auth: () => s.auth(), handleApiError } : s;
  };
  const progress = createProgressStore({ api: ctx.api, session });
  return { ...ctx, progress };
}

beforeEach(() => {
  jest.useFakeTimers();
  mmkv.clearAll();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('load() fills the epics', async () => {
  const { progress } = await setup();
  await progress.getState().load();
  expect(progress.getState().epics[0]!.ref).toBe('TER-182');
  expect(progress.getState().error).toBeNull();
});

it('polls every 20 s while started, and stops', async () => {
  const { progress, api } = await setup();
  const spy = jest.spyOn(api, 'progress');
  progress.getState().startPolling();
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  expect(spy).toHaveBeenCalledTimes(3); // immediate + two ticks
  progress.getState().stopPolling();
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  expect(spy).toHaveBeenCalledTimes(3);
});

it('keeps the last epics and shows an error when a refresh fails', async () => {
  const { progress, api } = await setup();
  await progress.getState().load();
  jest.spyOn(api, 'progress').mockRejectedValueOnce(new Error('offline'));
  await progress.getState().load();
  expect(progress.getState().epics).toHaveLength(1);
  expect(progress.getState().error).toBe('Não foi possível carregar o progresso.');
});

it('leaves session-ending errors to the session store and stops polling', async () => {
  const handled = jest.fn(() => true);
  const { progress, api } = await setup(handled);
  const spy = jest.spyOn(api, 'progress').mockRejectedValue(new Error('revoked'));
  progress.getState().startPolling();
  await jest.advanceTimersByTimeAsync(PROGRESS_POLL_MS * 2);
  expect(handled).toHaveBeenCalled();
  expect(progress.getState().error).toBeNull();
  expect(spy).toHaveBeenCalledTimes(1); // polling stopped after the first refusal
});
