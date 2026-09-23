// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureStill, fileNameFor, type FrameSource } from './images';

const info = { ownerName: 'Pedro', working: 1, waiting: 0, shortLink: '77a.it/pedro' };

/** A scene whose next render the test triggers by hand. */
function fakeSource() {
  const listeners = new Set<(c: HTMLCanvasElement) => void>();
  const source: FrameSource = {
    onFrame: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const render = () => [...listeners].forEach((cb) => cb({ width: 800, height: 600 } as HTMLCanvasElement));
  return { source, listeners, render };
}

const ctx = { save: vi.fn(), restore: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillText: vi.fn(), createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })) };
/** the size of every canvas turned into an image */
let encoded: string[] = [];

beforeEach(() => {
  encoded = [];
  // jsdom has no 2D canvas: the compositor's own tests cover what gets painted
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
    encoded.push(`${this.width}x${this.height}`);
    cb(new Blob(['png'], { type }));
  });
});

afterEach(() => vi.restoreAllMocks());

describe('captureStill', () => {
  it('draws the next rendered frame at the format’s size, as a PNG, and lets go of the scene', async () => {
    const { source, listeners, render } = fakeSource();
    const pending = captureStill(source, 'story', info);
    expect(listeners.size).toBe(1);
    render();
    const blob = await pending;
    expect(blob.type).toBe('image/png');
    expect(encoded).toEqual(['1080x1920']);
    expect(ctx.drawImage).toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('gives up when no frame comes (a hidden tab stops rendering)', async () => {
    const { source, listeners } = fakeSource();
    await expect(captureStill(source, 'post', info, 20)).rejects.toThrow(/no frame/);
    expect(listeners.size).toBe(0);
  });
});

describe('fileNameFor', () => {
  it('names the files after the city', () => {
    expect(fileNameFor('pedro', 'story', 'png')).toBe('termhub-cidade-pedro-story.png');
    expect(fileNameFor('pedro', 'post', 'png')).toBe('termhub-cidade-pedro-post.png');
    expect(fileNameFor('pedro', 'story', 'mp4')).toBe('termhub-cidade-pedro-story.mp4');
  });
});
