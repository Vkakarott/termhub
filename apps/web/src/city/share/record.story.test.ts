// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityModel } from '../../office/model';

const { sound } = vi.hoisted(() => ({
  sound: { stream: { getAudioTracks: () => [] }, play: vi.fn(), stop: vi.fn() },
}));
vi.mock('./sound', async (importOriginal) => ({ ...(await importOriginal<typeof import('./sound')>()), createSoundscape: () => sound }));

import { recordStory } from './record';

const closed = vi.fn(async () => {});
class FakeAudioContext {
  close = closed;
}
class FakeStream {
  constructor(public tracks: unknown[]) {}
  getTracks() {
    return [];
  }
}
class ThrowingRecorder {
  static isTypeSupported = () => true;
  constructor() {
    throw new DOMException('not supported', 'NotSupportedError');
  }
}

const info = () => ({ ownerName: 'Pedro', working: 0, waiting: 0, shortLink: '77a.it/pedro' });
const model = () => ({ buildings: [], needsYou: 0 }) as unknown as CityModel;

beforeEach(() => {
  sound.stop.mockReset();
  closed.mockClear();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('MediaRecorder', ThrowingRecorder);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as unknown as CanvasRenderingContext2D);
  Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', { configurable: true, value: () => ({ getVideoTracks: () => [] }) });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('recordStory', () => {
  it('lets go of the scene, the sound and the audio when the recorder cannot even start', async () => {
    const off = vi.fn();
    const source = { onFrame: vi.fn(() => off) };
    const rec = recordStory({ source, info, model });
    await expect(rec.done).rejects.toThrow();
    expect(off).toHaveBeenCalledTimes(1);
    expect(sound.stop).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(1);
    rec.cancel(); // harmless
  });

  it('lets go the same way when the canvas cannot be captured', async () => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'captureStream', {
      configurable: true,
      value: () => {
        throw new Error('no capture');
      },
    });
    const off = vi.fn();
    const rec = recordStory({ source: { onFrame: () => off }, info, model });
    await expect(rec.done).rejects.toThrow('no capture');
    expect(off).toHaveBeenCalledTimes(1);
    expect(sound.stop).toHaveBeenCalledTimes(1);
  });
});
