import { redirectFor } from './redirect';

describe('redirectFor', () => {
  it('lets an unlocked session sit on the conversation screen', () => {
    expect(redirectFor('unlocked', ['chat', 'c1'], null)).toEqual({ target: null, shouldClear: false });
  });

  it('lets an unlocked session sit on the tabs', () => {
    expect(redirectFor('unlocked', ['(tabs)'], null)).toEqual({ target: null, shouldClear: false });
  });

  it('sends an unlocked session on a session route back to the tabs', () => {
    expect(redirectFor('unlocked', ['unlock'], null)).toEqual({ target: '/(tabs)', shouldClear: false });
  });

  it('sends a locked session on the tabs back to Desbloquear', () => {
    expect(redirectFor('locked', ['(tabs)'], null)).toEqual({ target: '/unlock', shouldClear: false });
  });

  it('sends a new session on the enrolment flow back to Início', () => {
    expect(redirectFor('new', ['enrol', 'waiting'], null)).toEqual({ target: '/', shouldClear: false });
  });

  it('leaves the other phases on their own screen alone', () => {
    expect(redirectFor('waiting', ['enrol', 'waiting'], null)).toEqual({ target: null, shouldClear: false });
    expect(redirectFor('pin_setup', ['enrol', 'create-pin'], null)).toEqual({ target: null, shouldClear: false });
    expect(redirectFor('locked', ['unlock'], null)).toEqual({ target: null, shouldClear: false });
    expect(redirectFor('new', [], null)).toEqual({ target: null, shouldClear: false });
  });

  describe('a pending route (a deep link caught while locked)', () => {
    it('is followed, ahead of any other check, while segments have not caught up yet', () => {
      expect(redirectFor('unlocked', ['unlock'], '/chat/c1')).toEqual({ target: '/chat/c1', shouldClear: false });
    });

    it('is not cleared in the same pass that issues the replace', () => {
      // Same case as above, spelled out: `shouldClear` stays false until `segments` reflects it.
      const { shouldClear } = redirectFor('unlocked', ['unlock'], '/chat/c1');
      expect(shouldClear).toBe(false);
    });

    it('is cleared, with no further redirect, once segments show it was reached', () => {
      expect(redirectFor('unlocked', ['chat', 'c1'], '/chat/c1')).toEqual({ target: null, shouldClear: true });
    });

    it('never falls through to HOME.unlocked while still pending', () => {
      // Not yet arrived and not on any session route either: still the pending route, not '/(tabs)'.
      expect(redirectFor('unlocked', ['(tabs)'], '/chat/c1')).toEqual({ target: '/chat/c1', shouldClear: false });
    });
  });
});
