import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extensionFor, isWebm, pickMimeType, RecordingCancelled, runRecorder, VIDEO_TYPES } from './record';

describe('pickMimeType', () => {
  it('prefers MP4 with H.264 and AAC, then plain MP4, then WebM', () => {
    expect(VIDEO_TYPES).toEqual(['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm']);
    expect(pickMimeType(() => true)).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    expect(pickMimeType((t) => t === 'video/mp4' || t.startsWith('video/webm'))).toBe('video/mp4');
    expect(pickMimeType((t) => t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9,opus');
    expect(pickMimeType((t) => t === 'video/webm')).toBe('video/webm');
  });

  it('answers null when nothing is supported, or the question throws', () => {
    expect(pickMimeType(() => false)).toBeNull();
    expect(pickMimeType(() => { throw new Error('nope'); })).toBeNull();
  });

  it('names the file after the container', () => {
    expect(extensionFor('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe('mp4');
    expect(extensionFor('video/webm;codecs=vp9,opus')).toBe('webm');
    expect(isWebm('video/webm')).toBe(true);
    expect(isWebm('video/mp4')).toBe(false);
  });
});

class FakeRecorder {
  static last: FakeRecorder;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: unknown, public options: { mimeType: string }) {
    FakeRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['video'], { type: this.options.mimeType }) });
    this.onstop?.();
  }
}

describe('runRecorder', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('MediaRecorder', FakeRecorder);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('records for the whole duration, reporting progress, then lets go of everything', async () => {
    const onProgress = vi.fn();
    const cleanup = vi.fn();
    const rec = runRecorder({ stream: {} as MediaStream, mimeType: 'video/mp4', durationMs: 10_000, onProgress, cleanup });
    expect(FakeRecorder.last.options.mimeType).toBe('video/mp4');
    await vi.advanceTimersByTimeAsync(7_000);
    expect(onProgress).toHaveBeenLastCalledWith(7_000);
    expect(cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await rec.done;
    expect(result.mimeType).toBe('video/mp4');
    expect(result.blob.size).toBeGreaterThan(0);
    expect(onProgress).toHaveBeenLastCalledWith(10_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('cancelling rejects with RecordingCancelled and still lets go of everything', async () => {
    const cleanup = vi.fn();
    const rec = runRecorder({ stream: {} as MediaStream, mimeType: 'video/webm', durationMs: 10_000, cleanup });
    const settled = rec.done.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    rec.cancel();
    expect(await settled).toBeInstanceOf(RecordingCancelled);
    expect(cleanup).toHaveBeenCalledTimes(1);
    rec.cancel(); // a second cancel is harmless
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('a recorder error rejects with an error that is not a cancel', async () => {
    const rec = runRecorder({ stream: {} as MediaStream, mimeType: 'video/webm', durationMs: 10_000, cleanup: vi.fn() });
    const settled = rec.done.catch((e: unknown) => e);
    FakeRecorder.last.onerror?.();
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RecordingCancelled);
  });
});
