/**
 * The 10-second story video (spec 2026-09-23 §2.4), recorded in real time in the visitor's
 * browser: a 1080×1920 canvas redrawn with the compositor on every scene frame gives the video
 * track (captureStream), the synthesised soundscape gives the audio track, and a MediaRecorder
 * writes both. No server work.
 */
import type { CityModel } from '../../office/model';
import { drawFrame, FORMAT_SIZE, layoutFor, type ShareInfo } from './compose';
import type { FrameSource } from './images';
import { createSoundscape, soundEvents } from './sound';

export const STORY_VIDEO_MS = 10_000;

/**
 * First supported wins: H.264 + AAC in an MP4 is what Instagram takes; WebM is the fallback some
 * browsers only have. No bare 'video/mp4': Chromium accepts it and writes VP9 + Opus inside an MP4,
 * which Instagram refuses while the file name promises otherwise.
 */
export const VIDEO_TYPES: readonly string[] = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm'];

export function pickMimeType(isTypeSupported: (type: string) => boolean): string | null {
  for (const type of VIDEO_TYPES) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      /* a browser that throws on the question cannot record the answer */
    }
  }
  return null;
}

/** The type without its parameters: share sheets (Chrome's allowlist) compare 'video/mp4', not its codecs. */
export const baseType = (mimeType: string): string => mimeType.split(';')[0].trim().toLowerCase();
export const isWebm = (mimeType: string): boolean => baseType(mimeType) === 'video/webm';
export const extensionFor = (mimeType: string): 'mp4' | 'webm' => (isWebm(mimeType) ? 'webm' : 'mp4');

/** H.264 video and AAC audio in an MP4, judged by what the recorder says it wrote: anything else gets the warning. */
export function instagramReady(mimeType: string): boolean {
  const type = mimeType.toLowerCase();
  return baseType(type) === 'video/mp4' && type.includes('avc1') && type.includes('mp4a');
}

/** MediaRecorder, canvas capture and at least one type this browser can write. */
export function canRecordVideo(): boolean {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement === 'undefined') return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') return false;
  return pickMimeType((t) => MediaRecorder.isTypeSupported(t)) !== null;
}

export class RecordingCancelled extends Error {
  constructor() {
    super('recording cancelled');
    this.name = 'RecordingCancelled';
  }
}

export interface RecordingResult { blob: Blob; mimeType: string }
export interface Recording { done: Promise<RecordingResult>; cancel(): void }

const PROGRESS_MS = 250;

export function runRecorder(opts: { stream: MediaStream; mimeType: string; durationMs: number; onProgress?: (elapsedMs: number) => void; cleanup: () => void }): Recording {
  const recorder = new MediaRecorder(opts.stream, { mimeType: opts.mimeType });
  const chunks: Blob[] = [];
  let outcome: 'recorded' | 'cancelled' | 'failed' = 'recorded';
  let tick: ReturnType<typeof setInterval> | null = null;
  const started = Date.now();

  /** an error that stops an inactive recorder calls onstop by hand, and the browser may still fire its own stop */
  let finished = false;

  const done = new Promise<RecordingResult>((resolve, reject) => {
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      if (finished) return;
      finished = true;
      if (tick) clearInterval(tick);
      opts.cleanup();
      // what the browser really wrote, which may not be what was asked for
      const mimeType = recorder.mimeType || opts.mimeType;
      if (outcome === 'cancelled') reject(new RecordingCancelled());
      else if (outcome === 'failed') reject(new Error('the recorder failed'));
      else resolve({ blob: new Blob(chunks, { type: baseType(mimeType) }), mimeType });
    };
    recorder.onerror = () => {
      outcome = 'failed';
      if (recorder.state !== 'inactive') recorder.stop();
      else recorder.onstop?.(new Event('stop'));
    };
  });

  recorder.start(PROGRESS_MS);
  tick = setInterval(() => {
    const elapsed = Math.min(Date.now() - started, opts.durationMs);
    opts.onProgress?.(elapsed);
    if (elapsed >= opts.durationMs && recorder.state === 'recording') recorder.stop();
  }, PROGRESS_MS);

  return {
    done,
    cancel() {
      if (recorder.state === 'inactive') return;
      outcome = 'cancelled';
      recorder.stop();
    },
  };
}

export function recordStory(opts: { source: FrameSource; info: () => ShareInfo; model: () => CityModel; durationMs?: number; onProgress?: (elapsedMs: number) => void }): Recording {
  const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
  const canvas = document.createElement('canvas');
  canvas.width = FORMAT_SIZE.story.width;
  canvas.height = FORMAT_SIZE.story.height;
  const ctx = canvas.getContext('2d');
  if (!mimeType || !ctx) return { done: Promise.reject(new Error('this browser cannot record the video')), cancel: () => {} };

  // every piece is let go exactly once, whichever of them got built before something threw
  let audio: AudioContext | null = null;
  let sound: ReturnType<typeof createSoundscape> | null = null;
  let off: (() => void) | null = null;
  let stream: MediaStream | null = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    off?.();
    sound?.stop();
    stream?.getTracks().forEach((t) => t.stop());
    void audio?.close();
  };

  try {
    audio = new AudioContext();
    const soundscape = createSoundscape(audio);
    sound = soundscape;
    let heard: CityModel | null = null;
    // redraw on every scene frame; the counts and the sounds follow the model the page draws
    off = opts.source.onFrame((scene) => {
      drawFrame(ctx, layoutFor('story', opts.info()), scene);
      const model = opts.model();
      if (model !== heard) {
        soundscape.play(soundEvents(heard, model));
        heard = model;
      }
    });
    const video = canvas.captureStream(30);
    stream = new MediaStream([...video.getVideoTracks(), ...soundscape.stream.getAudioTracks()]);
    return runRecorder({ stream, mimeType, durationMs: opts.durationMs ?? STORY_VIDEO_MS, onProgress: opts.onProgress, cleanup });
  } catch (err) {
    // no AudioContext, no capture, a recorder that refuses the stream or will not start
    cleanup();
    return { done: Promise.reject(err instanceof Error ? err : new Error('the recording could not start')), cancel: () => {} };
  }
}
