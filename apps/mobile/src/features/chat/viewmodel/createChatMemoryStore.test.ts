// "Memória do chat" store (chat decision memory spec 2026-09-26 §5.2): driven over the real
// `HttpMobileApi` + `MockTransport` with an enrolled session, same setup as the notifications
// store's own tests (`createNotificationsStore.test.ts`).
import { sessionEnded } from '@/features/shared/signals';
import type { TChatDecision, TChatMemory, TConciergeNote, TDecisionsResponse, TNotesResponse } from '@/services/api/contract';
import { enrol, setupSession } from '../../../../test/helpers/enrolled-session';
import { createChatMemoryStore } from './createChatMemoryStore';

/** A resolved promise queued on the real event loop, not a fake timer — flushes every microtask
 * `runFirstPage`/`loadMore`/`toggle`/`forget`'s own `await`s chain through, however many hops deep. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function decision(over: Partial<TChatDecision> & { id: string }): TChatDecision {
  return {
    project_id: 'p-termhub',
    project_name: 'termhub',
    header: 'Worktree',
    question: 'Usar worktree?',
    options: [
      { label: 'Sim', description: '' },
      { label: 'Não', description: '' },
    ],
    multi_select: false,
    answer: { labels: ['Não'] },
    suggested_count: 2,
    accepted_count: 1,
    created_at: '2026-09-20T10:00:00.000Z',
    ...over,
  };
}

function note(over: Partial<TConciergeNote> & { id: string }): TConciergeNote {
  return {
    project_id: 'p-termhub',
    project_name: 'termhub',
    question: 'Usar worktree?',
    decision: 'Sim',
    reason: 'Você sempre isola em worktree',
    created_at: '2026-09-20T10:00:00.000Z',
    ...over,
  };
}

async function setup() {
  const ctx = setupSession();
  await enrol(ctx);
  const store = createChatMemoryStore({ api: ctx.api, session: () => ctx.store.getState() });
  return { ...ctx, store };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate'] });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('load() reads the switch and the first page from the seeded fixtures', async () => {
  const { store } = await setup();
  await store.getState().load();
  expect(store.getState().memory).toMatchObject({ enabled: true, available: true, count: 2 });
  expect(store.getState().decisions?.map((d) => d.id)).toEqual(['d-branch', 'd-worktree']);
  expect(store.getState().cursor).toBeNull();
});

it('search updates q at once and re-queries after the debounce', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const spy = jest.spyOn(api, 'chatDecisions');
  spy.mockClear();

  store.getState().search('worktree');
  expect(store.getState().q).toBe('worktree');
  expect(spy).not.toHaveBeenCalled();

  await jest.advanceTimersByTimeAsync(300);
  expect(spy).toHaveBeenCalledWith(expect.anything(), 'worktree');
  expect(store.getState().decisions?.map((d) => d.id)).toEqual(['d-worktree']);
});

it('a second search before the debounce fires cancels the first (only one request)', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const spy = jest.spyOn(api, 'chatDecisions');
  spy.mockClear();

  store.getState().search('w');
  await jest.advanceTimersByTimeAsync(200);
  store.getState().search('worktree');
  await jest.advanceTimersByTimeAsync(300);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith(expect.anything(), 'worktree');
});

it('cancel() clears a pending debounce timer: the search never fires', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const spy = jest.spyOn(api, 'chatDecisions');
  spy.mockClear();

  store.getState().search('worktree');
  store.getState().cancel();
  await jest.advanceTimersByTimeAsync(300);
  expect(spy).not.toHaveBeenCalled();
  // Nothing was touched: still the full, unfiltered list from `load()`.
  expect(store.getState().decisions?.map((d) => d.id)).toEqual(['d-branch', 'd-worktree']);
});

it('cancel() drops a first-page response already in flight (a search fired, then the screen left)', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const before = store.getState().decisions;
  let resolveSearch!: (v: TDecisionsResponse) => void;
  jest.spyOn(api, 'chatDecisions').mockImplementationOnce(() => new Promise((resolve) => (resolveSearch = resolve)));

  store.getState().search('worktree');
  await jest.advanceTimersByTimeAsync(300); // the debounce fires; the request is now in flight
  store.getState().cancel();
  resolveSearch({ decisions: [decision({ id: 'd-should-be-dropped' })], next_cursor: null });
  await tick();

  expect(store.getState().decisions).toEqual(before); // the cancelled response never landed
});

it("keeps the later search's results even if the earlier one resolves after it", async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const deferred: Array<(v: TDecisionsResponse) => void> = [];
  jest.spyOn(api, 'chatDecisions').mockImplementation(() => new Promise((resolve) => deferred.push(resolve)));

  store.getState().search('first');
  await jest.advanceTimersByTimeAsync(300);
  store.getState().search('second');
  await jest.advanceTimersByTimeAsync(300);
  expect(deferred).toHaveLength(2);

  // The newer ("second") request resolves first; the stale ("first") one resolves after it.
  deferred[1]!({ decisions: [decision({ id: 'd-second', question: 'Segunda pergunta' })], next_cursor: null });
  await tick();
  expect(store.getState().decisions?.map((d) => d.id)).toEqual(['d-second']);

  deferred[0]!({ decisions: [decision({ id: 'd-first', question: 'Primeira pergunta' })], next_cursor: null });
  await tick();
  expect(store.getState().decisions?.map((d) => d.id)).toEqual(['d-second']);
});

it('loadMore appends the next page and next_cursor null stops it (a further call is a no-op)', async () => {
  const { store, api } = await setup();
  const first = decision({ id: 'd1' });
  const second = decision({ id: 'd2', question: 'Outra pergunta?' });
  const spy = jest.spyOn(api, 'chatDecisions').mockImplementation(async (_auth, _q, cursor) => {
    if (!cursor) return { decisions: [first], next_cursor: 'd1' };
    expect(cursor).toBe('d1');
    return { decisions: [second], next_cursor: null };
  });

  await store.getState().load();
  expect(store.getState().decisions).toEqual([first]);
  expect(store.getState().cursor).toBe('d1');

  await store.getState().loadMore();
  expect(store.getState().decisions).toEqual([first, second]);
  expect(store.getState().cursor).toBeNull();

  const callsBefore = spy.mock.calls.length;
  await store.getState().loadMore(); // no cursor: no-op
  expect(spy.mock.calls.length).toBe(callsBefore);
});

it('toggle PATCHes the opposite of the current value', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const spy = jest.spyOn(api, 'setChatMemory');
  await store.getState().toggle();
  expect(spy).toHaveBeenCalledWith(expect.anything(), false);
  expect(store.getState().memory?.enabled).toBe(false);
});

it('forget deletes and removes the row locally', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const id = store.getState().decisions![0]!.id;
  const spy = jest.spyOn(api, 'forgetChatDecision');
  await store.getState().forget(id);
  expect(spy).toHaveBeenCalledWith(expect.anything(), id);
  expect(store.getState().decisions!.some((d) => d.id === id)).toBe(false);
});

it("toggling, then a search that completes before the PATCH does, still shows the toggle's own result", async () => {
  // Regression guard: toggle must not share the search's request-generation guard — a concurrent
  // search finishing first must never make the switch fall back to its pre-toggle value.
  const { store, api } = await setup();
  await store.getState().load();
  let resolveToggle!: (v: TChatMemory) => void;
  jest.spyOn(api, 'setChatMemory').mockImplementationOnce(() => new Promise((resolve) => (resolveToggle = resolve)));

  const togglePromise = store.getState().toggle();
  expect(store.getState().switching).toBe(true); // PATCH in flight, not yet resolved

  // A search starts and fully completes while the toggle's PATCH is still pending.
  store.getState().search('worktree');
  await jest.advanceTimersByTimeAsync(300);
  await tick();
  expect(store.getState().decisions?.map((d) => d.id)).toEqual(['d-worktree']);
  expect(store.getState().memory?.enabled).toBe(true); // unchanged: the toggle has not resolved yet

  // Only now does the toggle's own PATCH resolve; the switch must reflect it, not the search's read.
  resolveToggle({ enabled: false, autodecide: false, available: true, count: 2, notes: 0 });
  await togglePromise;
  expect(store.getState().memory?.enabled).toBe(false);
});

it('a search that started before a toggle completed never flips the switch back when it resolves later', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  expect(store.getState().memory?.enabled).toBe(true);

  // A search fires; its GET /memory (read before the PATCH lands) stays in flight.
  let resolveStaleMemory!: (v: TChatMemory) => void;
  jest.spyOn(api, 'chatMemory').mockImplementationOnce(() => new Promise((resolve) => (resolveStaleMemory = resolve)));
  store.getState().search('worktree');
  await jest.advanceTimersByTimeAsync(300);

  // The toggle goes through completely meanwhile.
  await store.getState().toggle();
  expect(store.getState().memory?.enabled).toBe(false);

  // Only now does the search's stale read arrive: its list applies, its switch value must not.
  resolveStaleMemory({ enabled: true, autodecide: false, available: true, count: 2, notes: 0 });
  await tick();
  expect(store.getState().memory?.enabled).toBe(false);
  expect(store.getState().decisions).not.toBeNull();
});

it('forgetting, then a search that completes before the DELETE does, still removes the row', async () => {
  const { store, api } = await setup();
  await store.getState().load();
  const target = store.getState().decisions![0]!;
  let resolveForget!: () => void;
  jest.spyOn(api, 'forgetChatDecision').mockImplementationOnce(() => new Promise((resolve) => (resolveForget = resolve)));

  const forgetPromise = store.getState().forget(target.id);
  expect(store.getState().forgettingId).toBe(target.id); // DELETE in flight

  // A search starts and fully completes — bringing the same row right back — while the DELETE is
  // still pending.
  store.getState().search('');
  await jest.advanceTimersByTimeAsync(300);
  await tick();
  expect(store.getState().decisions?.some((d) => d.id === target.id)).toBe(true);

  // Only now does the forget's own DELETE resolve; the row must disappear regardless of the search.
  resolveForget();
  await forgetPromise;
  expect(store.getState().decisions?.some((d) => d.id === target.id)).toBe(false);
});

describe('setAutodecide (concierge memory spec 2026-09-26 §6, D8)', () => {
  it('flips the switch at once (optimistic), then keeps the server\'s confirmed value', async () => {
    const { store, api } = await setup();
    await store.getState().load();
    expect(store.getState().memory?.autodecide).toBe(false);
    let resolveSet!: (v: TChatMemory) => void;
    const spy = jest.spyOn(api, 'setChatMemory').mockImplementationOnce(() => new Promise((resolve) => (resolveSet = resolve)));

    const p = store.getState().setAutodecide(true);
    expect(store.getState().memory?.autodecide).toBe(true); // optimistic, before the PATCH resolves
    expect(spy).toHaveBeenCalledWith(expect.anything(), { autodecide: true });

    resolveSet({ enabled: true, autodecide: true, available: true, count: 2, notes: 0 });
    await p;
    expect(store.getState().memory?.autodecide).toBe(true);
    expect(store.getState().error).toBeNull();
  });

  it('rolls back and shows "Não foi possível alterar a configuração" on failure', async () => {
    const { store, api } = await setup();
    await store.getState().load();
    jest.spyOn(api, 'setChatMemory').mockRejectedValueOnce(new Error('boom'));

    await store.getState().setAutodecide(true);

    expect(store.getState().memory?.autodecide).toBe(false); // rolled back
    expect(store.getState().error).toBe('Não foi possível alterar a configuração');
  });
});

describe('"Anotações do concierge" (spec D12/§8)', () => {
  it('loadNotes reads the first page', async () => {
    const { store, api } = await setup();
    jest.spyOn(api, 'chatNotes').mockResolvedValueOnce({ notes: [note({ id: 'n1' })], next_cursor: 'n1' });

    await store.getState().loadNotes();

    expect(store.getState().notes?.map((n) => n.id)).toEqual(['n1']);
    expect(store.getState().notesCursor).toBe('n1');
  });

  it('loadMoreNotes appends the next page and next_cursor null stops it (a further call is a no-op)', async () => {
    const { store, api } = await setup();
    const first = note({ id: 'n1' });
    const second = note({ id: 'n2', question: 'Outra pergunta?' });
    const spy = jest.spyOn(api, 'chatNotes').mockImplementation(async (_auth, cursor) => {
      if (!cursor) return { notes: [first], next_cursor: 'n1' } satisfies TNotesResponse;
      expect(cursor).toBe('n1');
      return { notes: [second], next_cursor: null } satisfies TNotesResponse;
    });

    await store.getState().loadNotes();
    expect(store.getState().notes).toEqual([first]);

    await store.getState().loadMoreNotes();
    expect(store.getState().notes).toEqual([first, second]);
    expect(store.getState().notesCursor).toBeNull();

    const callsBefore = spy.mock.calls.length;
    await store.getState().loadMoreNotes(); // no cursor: no-op
    expect(spy.mock.calls.length).toBe(callsBefore);
  });

  it('forgetNote deletes and removes the row locally', async () => {
    const { store, api } = await setup();
    jest.spyOn(api, 'chatNotes').mockResolvedValueOnce({ notes: [note({ id: 'n1' })], next_cursor: null });
    await store.getState().loadNotes();
    const spy = jest.spyOn(api, 'forgetChatNote');

    await store.getState().forgetNote('n1');

    expect(spy).toHaveBeenCalledWith(expect.anything(), 'n1');
    expect(store.getState().notes!.some((n) => n.id === 'n1')).toBe(false);
  });

  it('forgetNote failure shows "Não foi possível esquecer a anotação"', async () => {
    const { store, api } = await setup();
    jest.spyOn(api, 'chatNotes').mockResolvedValueOnce({ notes: [note({ id: 'n1' })], next_cursor: null });
    await store.getState().loadNotes();
    jest.spyOn(api, 'forgetChatNote').mockRejectedValueOnce(new Error('boom'));

    await store.getState().forgetNote('n1');

    expect(store.getState().notesError).toBe('Não foi possível esquecer a anotação');
    expect(store.getState().notes!.some((n) => n.id === 'n1')).toBe(true); // still there: the delete failed
  });
});

it('resets on sessionEnded', async () => {
  const { store } = await setup();
  await store.getState().load();
  expect(store.getState().decisions).not.toBeNull();

  sessionEnded.emit();

  expect(store.getState()).toMatchObject({ memory: null, decisions: null, cursor: null, q: '', error: null, notes: null, notesCursor: null, notesError: null });
});
