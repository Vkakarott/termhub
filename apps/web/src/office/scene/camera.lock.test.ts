// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Camera } from './camera';

const cameras: Camera[] = [];
function camera() {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const cam = new Camera(canvas);
  cameras.push(cam);
  return { cam, canvas };
}

const wheel = (canvas: HTMLCanvasElement) => canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, clientX: 10, clientY: 10, cancelable: true }));
function drag(canvas: HTMLCanvasElement) {
  canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0 }));
  window.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 30 }));
  window.dispatchEvent(new MouseEvent('pointerup'));
}

afterEach(() => {
  cameras.splice(0).forEach((c) => c.destroy());
  document.body.innerHTML = '';
});

describe('Camera.locked', () => {
  it('moves with the wheel and a drag while unlocked', () => {
    const { cam, canvas } = camera();
    const moved = vi.fn();
    cam.onUserMove = moved;
    wheel(canvas);
    expect(cam.target.scale).not.toBe(1);
    const before = { ...cam.target };
    drag(canvas);
    expect(cam.target.x).toBe(before.x + 40);
    expect(moved).toHaveBeenCalled();
  });

  it('ignores the wheel and a drag while locked, and says nothing moved', () => {
    const { cam, canvas } = camera();
    const moved = vi.fn();
    cam.onUserMove = moved;
    cam.locked = true;
    const before = { ...cam.target };
    wheel(canvas);
    drag(canvas);
    expect(cam.target).toEqual(before);
    expect(moved).not.toHaveBeenCalled();
    cam.locked = false;
    drag(canvas);
    expect(cam.target.x).toBe(before.x + 40);
  });

  it('stops a drag already under way when the camera locks mid-gesture', () => {
    const { cam, canvas } = camera();
    const before = { ...cam.target };
    canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 0, clientY: 0 }));
    cam.locked = true;
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 40, clientY: 30 }));
    expect(cam.target).toEqual(before);
    // unlocked again, the old press does not resume: the picture does not jump
    cam.locked = false;
    window.dispatchEvent(new MouseEvent('pointermove', { clientX: 80, clientY: 60 }));
    expect(cam.target).toEqual(before);
    window.dispatchEvent(new MouseEvent('pointerup'));
  });
});
