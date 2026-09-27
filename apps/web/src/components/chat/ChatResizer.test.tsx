// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatResizer, nudgeWidth, widthFromPointer } from './ChatResizer';

afterEach(cleanup);

describe('width math', () => {
  it('widthFromPointer measures from the aside right edge and clamps', () => {
    expect(widthFromPointer(1000, 500)).toBe(500);
    expect(widthFromPointer(1000, 900)).toBe(320);
    expect(widthFromPointer(1000, 0)).toBe(720);
  });

  it('nudgeWidth: ← widens, → narrows, Home/End go to max/min, other keys do nothing', () => {
    expect(nudgeWidth(420, 'ArrowLeft')).toBe(436);
    expect(nudgeWidth(420, 'ArrowRight')).toBe(404);
    expect(nudgeWidth(330, 'ArrowRight')).toBe(320);
    expect(nudgeWidth(420, 'Home')).toBe(720);
    expect(nudgeWidth(420, 'End')).toBe(320);
    expect(nudgeWidth(420, 'a')).toBeNull();
  });
});

/** jsdom 25 has no PointerEvent: a MouseEvent named like a pointer event carries clientX to React's handler. */
const pointer = (el: Element, type: string, clientX: number) => fireEvent(el, new MouseEvent(type, { bubbles: true, clientX }));

function mount(width = 420) {
  const onCommit = vi.fn();
  const { container } = render(
    <div style={{ position: 'relative' }}>
      <ChatResizer width={width} onCommit={onCommit} />
    </div>,
  );
  (container.firstChild as HTMLElement).getBoundingClientRect = () => ({ right: 1000 }) as DOMRect;
  return { onCommit, sep: screen.getByRole('separator', { name: 'Largura do chat' }) };
}

describe('ChatResizer', () => {
  it('exposes its value to assistive tech', () => {
    const { sep } = mount(500);
    expect(sep.getAttribute('aria-valuenow')).toBe('500');
    expect(sep.getAttribute('aria-valuemin')).toBe('320');
    expect(sep.getAttribute('aria-valuemax')).toBe('720');
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
  });

  it('commits once, on release, with an overlay over the page while dragging', () => {
    const { sep, onCommit } = mount();
    pointer(sep, 'pointerdown', 580);
    expect(screen.getByTestId('chat-resize-overlay')).toBeTruthy();
    pointer(sep, 'pointermove', 550);
    pointer(sep, 'pointermove', 500);
    expect(onCommit).not.toHaveBeenCalled();
    pointer(sep, 'pointerup', 500);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(500);
    expect(screen.queryByTestId('chat-resize-overlay')).toBeNull();
  });

  it('commits on each arrow key', () => {
    const { sep, onCommit } = mount();
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(onCommit).toHaveBeenLastCalledWith(436);
    fireEvent.keyDown(sep, { key: 'x' });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('double click goes back to 420', () => {
    const { sep, onCommit } = mount(600);
    fireEvent.doubleClick(sep);
    expect(onCommit).toHaveBeenCalledWith(420);
  });

  it('pointercancel resets overlay without committing', () => {
    const { sep, onCommit } = mount();
    pointer(sep, 'pointerdown', 580);
    expect(screen.getByTestId('chat-resize-overlay')).toBeTruthy();
    pointer(sep, 'pointermove', 550);
    pointer(sep, 'pointercancel', 550);
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByTestId('chat-resize-overlay')).toBeNull();
  });

  it('overlay fallback: pointermove and pointerup on overlay commit the width', () => {
    const { sep, onCommit } = mount();
    pointer(sep, 'pointerdown', 580);
    const overlay = screen.getByTestId('chat-resize-overlay');
    expect(overlay).toBeTruthy();
    pointer(overlay, 'pointermove', 550);
    pointer(overlay, 'pointermove', 500);
    expect(onCommit).not.toHaveBeenCalled();
    pointer(overlay, 'pointerup', 500);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(500);
    expect(screen.queryByTestId('chat-resize-overlay')).toBeNull();
  });
});
