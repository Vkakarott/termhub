import type { ChatEvent, ChatMessage } from './types';
import { applyLive, closeLive, emptyFold, foldLive, pruneLive, seedLive } from './live';

const USER_ID = 'u1';
const CONVERSATION_ID = 'c1';
const T0 = '2026-01-01T00:00:00.000Z';

function delta(messageId: string, text: string): ChatEvent {
  return { type: 'delta', user_id: USER_ID, conversation_id: CONVERSATION_ID, message_id: messageId, delta: text };
}

function toolCall(messageId: string, tool: string): ChatEvent {
  return { type: 'action', user_id: USER_ID, conversation_id: CONVERSATION_ID, message_id: messageId, tool, tool_use_id: `tu-${tool}`, args: {} };
}

function reset(messageId: string): ChatEvent {
  return { type: 'reset', user_id: USER_ID, conversation_id: CONVERSATION_ID, message_id: messageId };
}

function assistantMessage(id: string, overrides: { text?: string; error_code?: string | null } = {}): ChatEvent {
  return {
    type: 'message',
    user_id: USER_ID,
    conversation_id: CONVERSATION_ID,
    message: { id, conversation_id: CONVERSATION_ID, role: 'assistant', text: overrides.text ?? '', usage: null, error_code: overrides.error_code ?? null, created_at: T0 },
  };
}

function userMessage(id: string): ChatEvent {
  return {
    type: 'message',
    user_id: USER_ID,
    conversation_id: CONVERSATION_ID,
    message: { id, conversation_id: CONVERSATION_ID, role: 'user', text: 'oi', usage: null, error_code: null, created_at: T0 },
  };
}

const hello: ChatEvent = { type: 'hello', protocol: 1, server_time: T0 };

function confirmation(actionId: string): ChatEvent {
  return {
    type: 'confirmation',
    user_id: USER_ID,
    conversation_id: CONVERSATION_ID,
    action_id: actionId,
    tool: 'Bash',
    args: {},
    class: 'write',
    machine_id: null,
    project_id: null,
    tab_id: null,
    summary: 'digitar `npm test` na aba api do projeto termhub',
    created_at: T0,
  };
}

function decision(actionId: string): ChatEvent {
  return { type: 'decision', user_id: USER_ID, conversation_id: CONVERSATION_ID, action_id: actionId, status: 'approved' };
}

describe('foldLive', () => {
  it('returns empty maps and set for no events', () => {
    const result = foldLive([]);
    expect(result.deltas.size).toBe(0);
    expect(result.actions.size).toBe(0);
    expect(result.started.size).toBe(0);
  });

  it('concatenates delta text per message id, independently of other messages', () => {
    const result = foldLive([delta('m1', 'ol'), delta('m1', 'á'), delta('m2', 'x')]);
    expect(result.deltas.get('m1')).toBe('olá');
    expect(result.deltas.get('m2')).toBe('x');
  });

  it('marks a message with any delta as started', () => {
    const result = foldLive([delta('m1', 'a')]);
    expect(result.started.has('m1')).toBe(true);
  });

  it('accumulates tool calls per message id, in the order they arrived', () => {
    const result = foldLive([toolCall('m1', 'Bash'), toolCall('m1', 'Read')]);
    expect(result.actions.get('m1')).toEqual([{ tool: 'Bash' }, { tool: 'Read' }]);
  });

  it('marks a message with a tool call as started', () => {
    const result = foldLive([toolCall('m1', 'Bash')]);
    expect(result.started.has('m1')).toBe(true);
  });

  it('reset drops the accumulated deltas and tool calls for that message only', () => {
    const result = foldLive([delta('m1', 'olá'), toolCall('m1', 'Bash'), delta('m2', 'oi'), reset('m1')]);
    expect(result.deltas.has('m1')).toBe(false);
    expect(result.actions.has('m1')).toBe(false);
    expect(result.deltas.get('m2')).toBe('oi');
  });

  it('reset does not mark the message as started on its own', () => {
    const result = foldLive([reset('m1')]);
    expect(result.started.has('m1')).toBe(false);
  });

  it('marks an empty assistant message (no text, no error) as started', () => {
    const result = foldLive([assistantMessage('m1')]);
    expect(result.started.has('m1')).toBe(true);
  });

  it('does not mark a finished assistant message (with text) as started', () => {
    const result = foldLive([assistantMessage('m1', { text: 'pronto' })]);
    expect(result.started.has('m1')).toBe(false);
  });

  it('does not mark a failed assistant message (with an error_code) as started', () => {
    const result = foldLive([assistantMessage('m1', { error_code: 'HOST_GONE' })]);
    expect(result.started.has('m1')).toBe(false);
  });

  it('does not mark a user message as started', () => {
    const result = foldLive([userMessage('m1')]);
    expect(result.started.has('m1')).toBe(false);
  });

  it('ignores hello, confirmation and decision events entirely', () => {
    const result = foldLive([hello, confirmation('a1'), decision('a1')]);
    expect(result.deltas.size).toBe(0);
    expect(result.actions.size).toBe(0);
    expect(result.started.size).toBe(0);
  });
});

function runStarted(messageId: string): ChatEvent {
  return { type: 'run_started', user_id: USER_ID, conversation_id: CONVERSATION_ID, message_id: messageId };
}

function runFinished(messageId: string | null, ok = true): ChatEvent {
  return { type: 'run_finished', user_id: USER_ID, conversation_id: CONVERSATION_ID, message_id: messageId, ok, error_code: ok ? null : 'SETUP_FAILED' };
}

function messageRemoved(messageId: string): ChatEvent {
  return { type: 'message_removed', user_id: USER_ID, conversation_id: CONVERSATION_ID, message_id: messageId };
}

// Rewritten on purpose (spec 2026-09-29 §5): `run_finished` with an id used to be ignored; it now
// closes the row, and only the null id (a run that could not start) leaves the fold alone.
it('run_finished with an id closes the row: what streamed goes, the started mark goes, and nothing opens it again', () => {
  const folded = foldLive([delta('m1', 'oi'), runFinished('m1')]);
  expect(folded.deltas.has('m1')).toBe(false);
  expect(folded.started.has('m1')).toBe(false);
  expect(folded.closed.has('m1')).toBe(true);
  expect(folded.removed.has('m1')).toBe(false);
  expect(applyLive(folded, runFinished('m1'))).toBe(folded);
  expect(applyLive(folded, runStarted('m1'))).toBe(folded);
  expect(applyLive(folded, delta('m1', 'late'))).toBe(folded);  // An id the fold never saw: closed, and not marked started.
  const unseen = applyLive(emptyFold(), runFinished('m9'));
  expect(unseen.closed.has('m9')).toBe(true);
  expect(unseen.started.has('m9')).toBe(false);
});

it('run_finished with message_id null returns the very same fold', () => {
  const fold = foldLive([delta('m1', 'oi')]);
  expect(applyLive(fold, runFinished(null, false))).toBe(fold);
  expect(applyLive(fold, runFinished(null, true))).toBe(fold);
});

describe('run state (spec 2026-09-29 §5)', () => {
  it('emptyFold has empty closed and removed sets', () => {
    const fold = emptyFold();
    expect(fold.closed.size).toBe(0);
    expect(fold.removed.size).toBe(0);
  });

  it('run_started marks the row started, and the same fold comes back the second time', () => {
    const fold = applyLive(emptyFold(), runStarted('m1'));
    expect(fold.started.has('m1')).toBe(true);
    expect(applyLive(fold, runStarted('m1'))).toBe(fold);
  });

  it('seedLive adds the listed ids, skips closed ones, and returns the very same fold when nothing is new', () => {
    const closed = applyLive(emptyFold(), runFinished('m2'));
    const seeded = seedLive(closed, ['m1', 'm2']);
    expect(seeded.started.has('m1')).toBe(true);
    expect(seeded.started.has('m2')).toBe(false);
    expect(seedLive(seeded, ['m1', 'm2'])).toBe(seeded);
    expect(seedLive(seeded, [])).toBe(seeded);
  });

  it('a final message closes the row: seedLive, run_started and an empty message for that id all return the same fold', () => {
    const done = applyLive(applyLive(emptyFold(), delta('m1', 'oi')), assistantMessage('m1', { text: 'oi' }));
    expect(done.closed.has('m1')).toBe(true);
    expect(done.started.has('m1')).toBe(false);
    expect(seedLive(done, ['m1'])).toBe(done);
    expect(applyLive(done, runStarted('m1'))).toBe(done);
    expect(applyLive(done, assistantMessage('m1'))).toBe(done);
    const failed = applyLive(emptyFold(), assistantMessage('m2', { error_code: 'HOST_GONE' }));
    expect(failed.closed.has('m2')).toBe(true);
  });

  it('message_removed closes the row, drops what streamed and adds the id to removed', () => {
    const fold = foldLive([delta('m1', 'oi'), toolCall('m1', 'Bash'), delta('m2', 'x')]);
    const gone = applyLive(fold, messageRemoved('m1'));
    expect(gone.deltas.has('m1')).toBe(false);
    expect(gone.actions.has('m1')).toBe(false);
    expect(gone.started.has('m1')).toBe(false);
    expect(gone.closed.has('m1')).toBe(true);
    expect(gone.removed.has('m1')).toBe(true);
    expect(gone.deltas.get('m2')).toBe('x');
    expect(applyLive(gone, messageRemoved('m1'))).toBe(gone);
  });

  it('message_removed for an id the fold never saw still adds it to removed and closed', () => {
    const gone = applyLive(emptyFold(), messageRemoved('m9'));
    expect(gone.removed.has('m9')).toBe(true);
    expect(gone.closed.has('m9')).toBe(true);
    expect(seedLive(gone, ['m9'])).toBe(gone);
  });

  it('a removed mark outlives a later final message for the same id', () => {
    const gone = applyLive(emptyFold(), messageRemoved('m1'));
    expect(applyLive(gone, assistantMessage('m1', { text: 'x' })).removed.has('m1')).toBe(true);
  });

  it('closeLive closes the listed rows without marking them removed; the same fold when nothing is new', () => {
    const fold = foldLive([delta('m1', 'oi'), delta('m2', 'x')]);
    const closed = closeLive(fold, ['m1', 'm3']);
    expect(closed.deltas.has('m1')).toBe(false);
    expect(closed.started.has('m1')).toBe(false);
    expect(closed.closed.has('m1')).toBe(true);
    expect(closed.closed.has('m3')).toBe(true);
    expect(closed.removed.size).toBe(0);
    expect(closed.deltas.get('m2')).toBe('x');
    expect(closeLive(closed, ['m1', 'm3'])).toBe(closed);
    expect(closeLive(fold, [])).toBe(fold);
  });
});

describe('applyLive', () => {
  it('returns the very same fold for an event that changes nothing, and replaces only the map it touched', () => {
    const fold = foldLive([delta('m1', 'oi')]);
    expect(applyLive(fold, hello)).toBe(fold);
    expect(applyLive(fold, confirmation('a1'))).toBe(fold);
    expect(applyLive(fold, userMessage('m9'))).toBe(fold);
    expect(applyLive(fold, reset('m2'))).toBe(fold); // nothing streamed for m2

    const next = applyLive(fold, delta('m1', '!'));
    expect(next).not.toBe(fold);
    expect(next.deltas.get('m1')).toBe('oi!');
    expect(next.actions).toBe(fold.actions); // untouched map keeps its reference
    expect(next.started).toBe(fold.started); // m1 was started already
    expect(fold.deltas.get('m1')).toBe('oi'); // the old fold is never mutated
  });

  it('an announce marks the row started; its final message drops everything of that id, and only that id', () => {
    const announced = applyLive(emptyFold(), assistantMessage('m1'));
    expect([...announced.started]).toEqual(['m1']);
    expect(applyLive(announced, assistantMessage('m1'))).toBe(announced);

    const streaming = applyLive(applyLive(announced, delta('m1', 'oi')), delta('m2', 'x'));
    const done = applyLive(streaming, assistantMessage('m1', { text: 'oi' }));
    expect(done.deltas.has('m1')).toBe(false);
    expect(done.started.has('m1')).toBe(false);
    expect(done.deltas.get('m2')).toBe('x');
    expect(applyLive(done, assistantMessage('m1', { text: 'oi' }))).toBe(done);
  });

  it('foldLive is applyLive over the events, from an empty fold', () => {
    const events = [delta('m1', 'a'), toolCall('m1', 'Bash'), reset('m1'), delta('m1', 'b')];
    expect(foldLive(events)).toEqual(events.reduce(applyLive, emptyFold()));
    expect(foldLive([])).toEqual(emptyFold());
  });

  describe('pruneLive (after a re-read)', () => {
    const row = (id: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, conversation_id: CONVERSATION_ID, role: 'assistant', text: '', usage: null, error_code: null, created_at: T0, ...extra });

    it('drops the entries of rows the thread shows finished (text or an error) and keeps the rest: a row still empty, or one the thread lacks', () => {
      const fold = foldLive([delta('m1', 'a'), toolCall('m1', 'Bash'), delta('m2', 'b'), delta('m3', 'c'), delta('m4', 'd')]);
      const pruned = pruneLive(fold, [row('m1', { text: 'done' }), row('m2', { error_code: 'HOST_GONE' }), row('m3')]);
      expect(pruned.deltas.has('m1')).toBe(false);
      expect(pruned.actions.has('m1')).toBe(false);
      expect(pruned.started.has('m1')).toBe(false);
      expect(pruned.deltas.has('m2')).toBe(false);
      expect(pruned.deltas.get('m3')).toBe('c');
      expect(pruned.started.has('m3')).toBe(true);
      expect(pruned.deltas.get('m4')).toBe('d');
    });

    it('closes the rows the thread shows finished: nothing opens them again', () => {
      const pruned = pruneLive(emptyFold(), [row('m1', { text: 'done' }), row('m2')]);
      expect(pruned.closed.has('m1')).toBe(true);
      expect(pruned.closed.has('m2')).toBe(false);
      expect(seedLive(pruned, ['m1'])).toBe(pruned);
      expect(applyLive(pruned, runStarted('m1'))).toBe(pruned);
    });

    it('hands back the very same fold when nothing is finished, and ignores user rows', () => {
      const fold = foldLive([delta('m1', 'a')]);
      expect(pruneLive(fold, [row('m1'), row('u1', { role: 'user', text: 'oi' })])).toBe(fold);
      expect(pruneLive(fold, [])).toBe(fold);
    });
  });
});
