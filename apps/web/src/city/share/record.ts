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

/** First supported wins: MP4 is what Instagram takes; WebM is the fallback some browsers only have. */
export const VIDEO_TYPES: readonly string[] = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];

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

export const isWebm = (mimeType: string): boolean => mimeType.startsWith('video/webm');
export const extensionFor = (mimeType: string): 'mp4' | 'webm' => (isWebm(mimeType) ? 'webm' : 'mp4');

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

  const done = new Promise<RecordingResult>((resolve, reject) => {
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = () => {
      if (tick) clearInterval(tick);
      opts.cleanup();
      if (outcome === 'cancelled') reject(new RecordingCancelled());
      else if (outcome === 'failed') reject(new Error('the recorder failed'));
      else resolve({ blob: new Blob(chunks, { type: opts.mimeType }), mimeType: opts.mimeType });
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

  const audio = new AudioContext();
  const sound = createSoundscape(audio);
  let heard: CityModel | null = null;
  // redraw on every scene frame; the counts and the sounds follow the model the page draws
  const off = opts.source.onFrame((scene) => {
    drawFrame(ctx, layoutFor('story', opts.info()), scene);
    const model = opts.model();
    if (model !== heard) {
      sound.play(soundEvents(heard, model));
      heard = model;
    }
  });
  const video = canvas.captureStream(30);
  const stream = new MediaStream([...video.getVideoTracks(), ...sound.stream.getAudioTracks()]);

  return runRecorder({
    stream,
    mimeType,
    durationMs: opts.durationMs ?? STORY_VIDEO_MS,
    onProgress: opts.onProgress,
    cleanup: () => {
      off();
      sound.stop();
      stream.getTracks().forEach((t) => t.stop());
      void audio.close();
    },
  });
}
