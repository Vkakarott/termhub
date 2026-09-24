// Pure routing decision (design spec §8) — no `expo-router` or `react-native` import, so this
// runs in the `logic` project, same as the store's own tests.
import { redirectFor } from './use-phase-redirect';

describe('redirectFor', () => {
  it('lets an unlocked session sit on the conversation screen', () => {
    expect(redirectFor('unlocked', ['chat', 'c1'], null)).toBeNull();
  });

  it('lets an unlocked session sit on the tabs', () => {
    expect(redirectFor('unlocked', ['(tabs)'], null)).toBeNull();
  });

  it('sends an unlocked session on a session route back to the tabs', () => {
    expect(redirectFor('unlocked', ['unlock'], null)).toBe('/(tabs)');
  });

  it('sends a locked session on the tabs back to Desbloquear', () => {
    expect(redirectFor('locked', ['(tabs)'], null)).toBe('/unlock');
  });

  it('sends a new session on the enrolment flow back to Início', () => {
    expect(redirectFor('new', ['enrol', 'waiting'], null)).toBe('/');
  });

  it('follows a pending route once unlocked, ahead of any other check', () => {
    expect(redirectFor('unlocked', ['unlock'], '/chat/c1')).toBe('/chat/c1');
  });

  it('leaves the other phases on their own screen alone', () => {
    expect(redirectFor('waiting', ['enrol', 'waiting'], null)).toBeNull();
    expect(redirectFor('pin_setup', ['enrol', 'create-pin'], null)).toBeNull();
    expect(redirectFor('locked', ['unlock'], null)).toBeNull();
    expect(redirectFor('new', [], null)).toBeNull();
  });
});
