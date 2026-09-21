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

    // jsdom lays nothing out and clamps nothing, so the *order of writes* is what is observed here:
    // a real browser clamps `scrollTop` to the collapsed box while it is collapsed, and restoring
    // the rows does not bring the scroll back — a message past MAX_ROWS jumped to its first line on
    // every keystroke.
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
