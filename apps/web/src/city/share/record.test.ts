import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { baseType, extensionFor, instagramReady, isWebm, pickMimeType, RecordingCancelled, runRecorder, VIDEO_TYPES } from './record';

describe('pickMimeType', () => {
  it('prefers MP4 with H.264 and AAC, then WebM — never a bare MP4, which Chromium fills with VP9', () => {
    expect(VIDEO_TYPES).toEqual(['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm']);
    expect(pickMimeType(() => true)).toBe('video/mp4;codecs=avc1.42E01E,mp4a.40.2');
    expect(pickMimeType((t) => t === 'video/mp4' || t.startsWith('video/webm'))).toBe('video/webm;codecs=vp9,opus');
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

  it('calls a video Instagram-ready only for H.264 and AAC in an MP4, as the recorder reports it', () => {
    expect(instagramReady('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe(true);
    expect(instagramReady('video/mp4; codecs="avc1.42E01E, mp4a.40.2"')).toBe(true);
    expect(instagramReady('VIDEO/MP4;codecs=AVC1.42E01E,MP4A.40.2')).toBe(true);
    expect(instagramReady('video/mp4')).toBe(false);
    expect(instagramReady('video/mp4;codecs=vp9,opus')).toBe(false);
    expect(instagramReady('video/mp4;codecs=avc1.42E01E,opus')).toBe(false);
    expect(instagramReady('video/webm;codecs=vp9,opus')).toBe(false);
  });

  it('drops the codecs for a file type: share sheets compare the bare type', () => {
    expect(baseType('video/mp4;codecs=avc1.42E01E,mp4a.40.2')).toBe('video/mp4');
    expect(baseType('video/webm ; codecs=vp9')).toBe('video/webm');
    expect(baseType('video/webm')).toBe('video/webm');
  });
});

class FakeRecorder {
  static last: FakeRecorder;
  /** what the browser really writes: the requested type unless a test says otherwise */
  static actual: string | null = null;
  mimeType: string;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: unknown, public options: { mimeType: string }) {
    FakeRecorder.last = this;
    this.mimeType = FakeRecorder.actual ?? options.mimeType;
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
    FakeRecorder.actual = null;
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
    expect(result.blob.type).toBe('video/mp4');
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

  it('reports what the recorder really wrote, and types the file with its bare type', async () => {
    FakeRecorder.actual = 'video/mp4;codecs=vp9,opus';
    const rec = runRecorder({ stream: {} as MediaStream, mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', durationMs: 1_000, cleanup: vi.fn() });
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await rec.done;
    expect(result.mimeType).toBe('video/mp4;codecs=vp9,opus');
    expect(result.blob.type).toBe('video/mp4');
  });

  it('falls back on the requested type when the recorder reports none', async () => {
    FakeRecorder.actual = '';
    const rec = runRecorder({ stream: {} as MediaStream, mimeType: 'video/webm;codecs=vp9,opus', durationMs: 1_000, cleanup: vi.fn() });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await rec.done).mimeType).toBe('video/webm;codecs=vp9,opus');
  });

  it('lets go of everything once, even when an error and a stop both arrive', async () => {
    const cleanup = vi.fn();
    const rec = runRecorder({ stream: {} as MediaStream, mimeType: 'video/webm', durationMs: 10_000, cleanup });
    const settled = rec.done.catch((e: unknown) => e);
    FakeRecorder.last.state = 'inactive';
    FakeRecorder.last.onerror?.();
    // the browser's own stop event after the error
    FakeRecorder.last.onstop?.();
    expect(await settled).toBeInstanceOf(Error);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
