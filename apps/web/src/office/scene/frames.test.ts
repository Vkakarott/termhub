import { describe, expect, it, vi } from 'vitest';
import { FrameListeners } from './frames';

const canvas = { width: 10, height: 10 } as HTMLCanvasElement;

describe('FrameListeners', () => {
  it('hands every listener the canvas after a render to the screen, until it unsubscribes', () => {
    const frames = new FrameListeners();
    const a = vi.fn();
    const off = frames.add(a);
    frames.emit(canvas, true);
    expect(a).toHaveBeenCalledWith(canvas);
    off();
    frames.emit(canvas, true);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for a render into a texture: the canvas holds no new frame then', () => {
    const frames = new FrameListeners();
    const a = vi.fn();
    frames.add(a);
    frames.emit(canvas, false);
    expect(a).not.toHaveBeenCalled();
  });

  it('keeps going past a listener that throws', () => {
    const frames = new FrameListeners();
    const b = vi.fn();
    frames.add(() => {
      throw new Error('broken share');
    });
    frames.add(b);
    expect(() => frames.emit(canvas, true)).not.toThrow();
    expect(b).toHaveBeenCalled();
  });
});
