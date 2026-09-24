// One mock transport, one session store and one chat store over it, for the `ui` project: a
// screen test mocks `useSessionStore` and `useChatStore` with these two (each `jest.mock` factory
// requires this module, and Jest's registry hands both the same instance within a test file).
// `enrolStores()` leaves the session unlocked; run it once, in `beforeAll`.
import { createChatStore } from '@/features/chat/viewmodel/createChatStore';
import { enrol, setupSession } from './enrolled-session';

const ctx = setupSession(Date.now());

export const stores = {
  ...ctx,
  chat: createChatStore({ api: ctx.api, session: () => ctx.store.getState() }),
};

export async function enrolStores(): Promise<void> {
  jest.useFakeTimers();
  try {
    await enrol(ctx);
  } finally {
    jest.useRealTimers();
  }
}
