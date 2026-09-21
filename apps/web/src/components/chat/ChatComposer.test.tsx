// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from './ChatComposer';

/** The composer is controlled, and its autosize only runs when the value it is given changes. */
function Harness({ onSend = () => {} }: { onSend?: () => void } = {}) {
  const [value, setValue] = useState('');
  return <ChatComposer value={value} onChange={setValue} onSend={onSend} sending={false} />;
}

afterEach(() => {
  cleanup();
  // enterSends() asks `matchMedia` on every keystroke; the coarse-pointer test installs one.
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe('ChatComposer', () => {
  it('asks for the message in the box itself', () => {
    render(<Harness />);

    expect(screen.getByPlaceholderText('Pergunte ou peça algo às suas máquinas')).toBeTruthy();
  });

  it('keeps the box at 16px, because a smaller field makes iOS zoom the page on focus', () => {
    // Safari on iOS zooms into any field whose font is under 16px the moment it takes focus, and a
    // zoomed page is wider than the screen — which is what "tapping the box blows out the side"
    // was. jsdom neither zooms nor lays out, so the class is what can be pinned here; the effect
    // itself only shows on a device.
    render(<ChatComposer value="" onChange={() => {}} onSend={() => {}} sending={false} />);
    const box = screen.getByPlaceholderText(/pergunte/i);
    expect(box.className).toContain('text-base');
    expect(box.className).not.toContain('text-sm');
    // And the box keeps its own drag: without this, panning inside it is handed to whatever can
    // scroll next, which on a phone was the document.
    expect(box.className).toContain('overscroll-contain');
  });

  it('sends on Enter with a fine pointer, and writes a newline with Shift', () => {
    const onSend = vi.fn();
    // Installed, not assumed: with no `matchMedia` at all `enterSends()` returns true anyway, so this
    // test used to pass without ever touching the branch its own name is about.
    (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = () => ({ matches: false }) as MediaQueryList;
    render(<Harness onSend={onSend} />);
    const box = screen.getByPlaceholderText(/pergunte/i);

    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does not send on Enter with a coarse pointer, where Enter is how a line gets started', () => {
    const onSend = vi.fn();
    (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
      ({ matches: query.includes('coarse') }) as MediaQueryList;
    render(<Harness onSend={onSend} />);
    const box = screen.getByPlaceholderText(/pergunte/i);

    fireEvent.change(box, { target: { value: 'oi' } });
    fireEvent.keyDown(box, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
  });

  it('floors the autosize at one row, since jsdom measures nothing', () => {
    render(<Harness />);
    const box = screen.getByPlaceholderText(/pergunte/i) as HTMLTextAreaElement;

    // `scrollHeight` is 0 under jsdom, so the measured row count is 0 or negative: the floor is the
    // only thing standing between the box and an invalid `rows`.
    fireEvent.change(box, { target: { value: 'linha' } });

    expect(box.rows).toBe(1);
  });

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
