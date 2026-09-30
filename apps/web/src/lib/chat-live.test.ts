// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createLiveFold, useChatLive } from './chat-live';
import type { ChatEvent, ChatMessage } from './types';

const delta = (id: string, text: string): ChatEvent => ({ type: 'delta', message_id: id, delta: text, conversation_id: 'c1' });
const action = (id: string, tool: string): ChatEvent => ({ type: 'action', message_id: id, tool, tool_use_id: 'tu1', args: {}, conversation_id: 'c1' });
const announce = (id: string): ChatEvent => ({ type: 'message', conversation_id: 'c1', message: { id, conversation_id: 'c1', role: 'assistant', text: '', error_code: null, created_at: '' } as ChatMessage });
const final = (id: string, text = 'pronto'): ChatEvent => ({ type: 'message', conversation_id: 'c1', message: { id, conversation_id: 'c1', role: 'assistant', text, error_code: null, created_at: '' } as ChatMessage });

describe('createLiveFold', () => {
  it('folds deltas per message id, one frame at a time, and counts a version per change', () => {
    const fold = createLiveFold();
    expect(fold.version).toBe(0);
    expect(fold.apply(delta('m1', 'par'))).toBe(true);
    expect(fold.apply(delta('m1', 'cial'))).toBe(true);
    expect(fold.apply(delta('m2', 'outra'))).toBe(true);
    expect(fold.get('m1')).toEqual({ text: 'parcial', tools: [], started: true });
    expect(fold.get('m2')?.text).toBe('outra');
    expect(fold.version).toBe(3);
  });

  it('keeps the same tools array while only text streams, so a memoised row can bail out', () => {
    const fold = createLiveFold();
    fold.apply(action('m1', 'Bash'));
    const before = fold.get('m1')!.tools;
    fold.apply(delta('m1', 'x'));
    fold.apply(action('m2', 'Read'));
    expect(fold.get('m1')!.tools).toBe(before);
    expect(before).toEqual([{ tool: 'Bash' }]);
    fold.apply(action('m1', 'Read'));
    expect(fold.get('m1')!.tools).not.toBe(before);
    expect(fold.get('m1')!.tools).toEqual([{ tool: 'Bash' }, { tool: 'Read' }]);
  });

  it('ignores what is not its business and does not bump the version for it', () => {
    const fold = createLiveFold();
    expect(fold.apply({ type: 'action_result', message_id: 'm1', tool_use_id: 'tu1', ok: true })).toBe(false);
    expect(fold.apply({ type: 'grant_revoked', grant_id: 'g1' })).toBe(false);
    expect(fold.apply({ type: 'reset', message_id: 'nobody' })).toBe(false);
    expect(fold.version).toBe(0);
    expect(fold.get('m1')).toBeUndefined();
  });

  it('a reset drops what streamed for that id and keeps the row started', () => {
    const fold = createLiveFold();
    fold.apply(action('m1', 'Bash'));
    fold.apply(delta('m1', 'meia resposta'));
    expect(fold.apply({ type: 'reset', message_id: 'm1' })).toBe(true);
    expect(fold.get('m1')).toEqual({ text: '', tools: [], started: true });
  });

  it('a reset of an id it never saw changes nothing and creates nothing', () => {
    const fold = createLiveFold();
    expect(fold.apply({ type: 'reset', message_id: 'nobody' })).toBe(false);
    expect(fold.get('nobody')).toBeUndefined();
  });

  it('run_started marks a row started, once', () => {
    const fold = createLiveFold();
    expect(fold.apply({ type: 'run_started', message_id: 'm1' })).toBe(true);
    expect(fold.get('m1')).toEqual({ text: '', tools: [], started: true });
    expect(fold.apply({ type: 'run_started', message_id: 'm1' })).toBe(false);
  });

  it('seed marks the rows the server says are open', () => {
    const fold = createLiveFold();
    expect(fold.seed(['m1', 'm2'])).toBe(true);
    expect(fold.get('m1')?.started).toBe(true);
    expect(fold.get('m2')?.started).toBe(true);
    expect(fold.seed(['m1'])).toBe(false);
  });

  it('a row that ended is closed for good: nothing opens it again', () => {
    const fold = createLiveFold();
    fold.apply(announce('m1'));
    fold.apply(final('m1'));
    expect(fold.isClosed('m1')).toBe(true);
    expect(fold.seed(['m1'])).toBe(false);
    expect(fold.apply({ type: 'run_started', message_id: 'm1' })).toBe(false);
    expect(fold.apply(announce('m1'))).toBe(false);
    expect(fold.get('m1')).toBeUndefined();
  });

  it('run_finished closes its row, and with no row it changes nothing', () => {
    const fold = createLiveFold();
    fold.apply({ type: 'run_started', message_id: 'm1' });
    expect(fold.apply({ type: 'run_finished', message_id: 'm1', ok: true, error_code: null })).toBe(true);
    expect(fold.isClosed('m1')).toBe(true);
    expect(fold.apply({ type: 'run_finished', message_id: null, ok: false, error_code: 'SETUP_FAILED' })).toBe(false);
  });

  it('message_removed closes the row and remembers it was removed', () => {
    const fold = createLiveFold();
    fold.apply({ type: 'run_started', message_id: 'm1' });
    const before = fold.removed();
    expect(fold.apply({ type: 'message_removed', message_id: 'm1' })).toBe(true);
    expect(fold.get('m1')).toBeUndefined();
    expect(fold.isClosed('m1')).toBe(true);
    expect(fold.removed().has('m1')).toBe(true);
    expect(fold.removed()).not.toBe(before);
  });

  it('a removal of a row it never had is remembered too', () => {
    const fold = createLiveFold();
    fold.apply({ type: 'message_removed', message_id: 'ghost' });
    expect(fold.removed().has('ghost')).toBe(true);
    expect(fold.seed(['ghost'])).toBe(false);
  });

  it('clear forgets everything: another conversation is on screen', () => {
    const fold = createLiveFold();
    fold.apply(delta('m1', 'x'));
    fold.apply(final('m2'));
    fold.apply({ type: 'message_removed', message_id: 'm3' });
    fold.clear();
    expect(fold.get('m1')).toBeUndefined();
    expect(fold.isClosed('m2')).toBe(false);
    expect(fold.removed().size).toBe(0);
  });

  it('an announced empty assistant row is started with no text', () => {
    const fold = createLiveFold();
    expect(fold.apply(announce('m1'))).toBe(true);
    expect(fold.get('m1')).toEqual({ text: '', tools: [], started: true });
    // Announced again (a reconnect, a second tab): nothing changes.
    expect(fold.apply(announce('m1'))).toBe(false);
  });

  it('a stored message (text or an error) drops what streamed for that id', () => {
    const fold = createLiveFold();
    fold.apply(delta('m1', 'parcial'));
    fold.apply(action('m1', 'Bash'));
    const stored: ChatEvent = { type: 'message', conversation_id: 'c1', message: { id: 'm1', conversation_id: 'c1', role: 'assistant', text: 'parcial e completa', error_code: null, created_at: '' } };
    expect(fold.apply(stored)).toBe(true);
    expect(fold.get('m1')).toBeUndefined();

    fold.apply(delta('m2', 'meia'));
    const failed: ChatEvent = { type: 'message', conversation_id: 'c1', message: { id: 'm2', conversation_id: 'c1', role: 'assistant', text: '', error_code: 'RUN_FAILED', created_at: '' } };
    expect(fold.apply(failed)).toBe(true);
    expect(fold.get('m2')).toBeUndefined();
    // A user message never had an entry: nothing to drop, nothing changed.
    expect(fold.apply({ type: 'message', conversation_id: 'c1', message: { id: 'u1', conversation_id: 'c1', role: 'user', text: 'oi', error_code: null, created_at: '' } })).toBe(false);
  });
});

describe('useChatLive', () => {
  it('re-renders with a new version on a change, keeps the same fold, and hands out a stable push', () => {
    const { result } = renderHook(() => useChatLive());
    const { fold, push } = result.current;
    expect(result.current.version).toBe(0);
    act(() => push(delta('m1', 'oi')));
    expect(result.current.version).toBe(1);
    expect(result.current.fold).toBe(fold);
    expect(result.current.push).toBe(push);
    expect(fold.get('m1')?.text).toBe('oi');
    // Nothing changed, nothing rendered: the version stays.
    act(() => push({ type: 'reset', message_id: 'm9' }));
    expect(result.current.version).toBe(1);
  });

  it('hands out a stable seed and clear that re-render when the fold changed', () => {
    const { result } = renderHook(() => useChatLive());
    const { seed, clear } = result.current;
    act(() => seed(['m1']));
    expect(result.current.version).toBe(1);
    expect(result.current.fold.get('m1')?.started).toBe(true);
    act(() => seed(['m1']));
    expect(result.current.version).toBe(1);
    act(() => clear());
    expect(result.current.version).toBe(2);
    expect(result.current.fold.get('m1')).toBeUndefined();
    expect(result.current.seed).toBe(seed);
    expect(result.current.clear).toBe(clear);
  });
});
