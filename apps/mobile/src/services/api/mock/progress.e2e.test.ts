// End-to-end: `HttpMobileApi.progress` (Task 10) over `MockTransport`'s progress route — the
// signed client talking to the mock's fixed epic/card/agent fixture (spec 2026-09-26
// progress-panel D10).
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('progress lists the active epics through the signed client', async () => {
  const ctx = setupSession();
  await enrol(ctx);
  const auth = ctx.store.getState().auth();
  const res = await ctx.api.progress(auth);
  expect(res.epics[0]).toMatchObject({ ref: 'TER-182', title: 'Visão gerencial' });
  expect(res.epics[0]!.cards[0]!.agents?.[0]).toMatchObject({ needs_you: true, state: 'waiting_input' });
});
