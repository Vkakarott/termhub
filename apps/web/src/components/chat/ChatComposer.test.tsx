// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatComposer } from './ChatComposer';

/** The composer is controlled, and its autosize only runs when the value it is given changes. */
function Harness() {
  const [value, setValue] = useState('');
  return <ChatComposer value={value} onChange={setValue} onSend={() => {}} sending={false} />;
}

afterEach(() => {
  cleanup();
});

describe('ChatComposer', () => {
  it('restores the box\'s own scroll position across the autosize measurement', () => {
    render(<Harness />);
    const box = screen.getByPlaceholderText(/pergunte/i) as HTMLTextAreaElement;

    // What this proves: the autosize effect reads the box's `scrollTop` and writes it back after it
    // has finished setting `rows`, so the save/restore cannot be deleted without a test going red.
    //
    // What it does NOT prove: that the scroll position actually survives in a browser. jsdom performs
    // no layout and clamps nothing, so `scrollTop` here is just a number this test set — and a save
    // placed *after* the collapse instead of before it, which is the exact wrong order that
    // reproduces the bug on a phone, would read the already-clamped value in a real browser and still
    // pass here. Only a phone can show that. Instrumenting property access to pin the order was
    // judged to cost more than the bug it would guard.
    const writes: string[] = [];
    let scrollTop = 120;
    let rows = 8;
    Object.defineProperty(box, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        writes.push(`scrollTop=${v}`);
        scrollTop = v;
      },
    });
    Object.defineProperty(box, 'rows', {
      configurable: true,
      get: () => rows,
      set: (v: number) => {
        writes.push(`rows=${v}`);
        rows = v;
      },
    });

    fireEvent.change(box, { target: { value: 'linha\n'.repeat(12) } });

    expect(writes.filter((w) => w.startsWith('rows='))).not.toHaveLength(0); // the measurement really ran
    expect(writes[writes.length - 1]).toBe('scrollTop=120');
    expect(box.scrollTop).toBe(120);
  });
});
