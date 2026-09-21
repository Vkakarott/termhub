// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatTurn } from './ChatTurn';
import type { ChatMessage } from '../../lib/types';

// Counted, not stubbed away for convenience: what this file pins is how often the answer is parsed
// and sanitised, which is invisible through the rendered output.
const renderMarkdown = vi.hoisted(() => vi.fn((text: string) => `<p>${text}</p>`));
vi.mock('../../lib/markdown', () => ({ renderMarkdown }));

function answer(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm1', conversation_id: 'c1', role: 'assistant', text: 'feito', error_code: null, created_at: '2026-09-21T00:00:00.000Z', ...overrides };
}

beforeEach(() => {
  renderMarkdown.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('ChatTurn', () => {
  it('renders the answer through the markdown-only path, not the notes one', () => {
    render(
      <ol>
        <ChatTurn message={answer()} waiting={false} failed={false} />
      </ol>,
    );

    expect(renderMarkdown).toHaveBeenCalledWith('feito', { markdownOnly: true });
  });

  it('does not re-parse the answer when the thread re-renders with the same props', () => {
    const message = answer();
    // A fresh element every time, deliberately: passing the very same element object back would
    // make React bail out on element identity alone and prove nothing about this component.
    const turn = () => (
      <ol>
        <ChatTurn message={message} waiting={false} failed={false} />
      </ol>
    );
    const { rerender } = render(turn());
    rerender(turn());
    rerender(turn());

    // A streamed answer re-renders the whole thread on every delta; parsing every row again each
    // time cost about 1 ms per message.
    expect(renderMarkdown).toHaveBeenCalledTimes(1);
  });

  it('does not run its own body again for unchanged props', () => {
    // `memo` is what stops the re-render entirely, and the parse count alone cannot see that (the
    // inner `useMemo` would hide it), so the render body is observed directly: `role` is read on
    // every pass through it.
    let reads = 0;
    const base = answer();
    const message = {
      ...base,
      get role() {
        reads += 1;
        return base.role;
      },
    } as ChatMessage;
    // Fresh elements with equal prop values: `memo`'s own shallow comparison is what must stop the
    // second pass, not React's element-identity bailout.
    const turn = () => (
      <ol>
        <ChatTurn message={message} waiting={false} failed={false} />
      </ol>
    );
    const { rerender } = render(turn());
    const afterFirst = reads;
    expect(afterFirst).toBeGreaterThan(0);

    rerender(turn());

    expect(reads).toBe(afterFirst);
  });

  it('does not re-parse an unchanged answer when only its tool list is a fresh array', () => {
    // `ChatPage` rebuilds `live.actions` on every event, so a row that saw a tool call gets a new
    // array identity on every delta and `memo` cannot bail out: the parse must still be cached.
    const message = answer();
    const { rerender } = render(
      <ol>
        <ChatTurn message={message} tools={[{ tool: 'Bash' }]} waiting={false} failed={false} />
      </ol>,
    );
    rerender(
      <ol>
        <ChatTurn message={message} tools={[{ tool: 'Bash' }]} waiting={false} failed={false} />
      </ol>,
    );

    expect(renderMarkdown).toHaveBeenCalledTimes(1);
  });

  it('parses again when the streamed body actually grows', () => {
    const message = answer({ text: '' });
    const { rerender } = render(
      <ol>
        <ChatTurn message={message} streaming="par" waiting={false} failed={false} />
      </ol>,
    );
    rerender(
      <ol>
        <ChatTurn message={message} streaming="parcial" waiting={false} failed={false} />
      </ol>,
    );

    expect(renderMarkdown.mock.calls.map((c) => c[0])).toEqual(['par', 'parcial']);
  });

  it('breaks long words in the answer, so one path cannot make the thread scroll sideways', () => {
    const { container } = render(
      <ol>
        <ChatTurn message={answer()} waiting={false} failed={false} />
      </ol>,
    );

    const prose = container.querySelector('.prose-termhub');
    expect(prose?.classList.contains('break-words')).toBe(true);
  });

  it('never parses the user\'s own words as Markdown', () => {
    render(
      <ol>
        <ChatTurn message={answer({ role: 'user', text: '**oi**' })} waiting={false} failed={false} />
      </ol>,
    );

    expect(renderMarkdown).not.toHaveBeenCalled();
  });
});
