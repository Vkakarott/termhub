// The singleton wiring: importing the store registers its renewal as the client's renewer.
import { useSessionStore } from './useSessionStore';

it('builds the session store over the mock singletons, hydrated and new', () => {
  const s = useSessionStore.getState();
  expect(s).toMatchObject({ phase: 'new', hydrated: true, request: null });
  expect(s.mockControls).not.toBeNull();
  expect(() => s.auth()).toThrow('LOCKED');
});
