import { api } from './api';
import type { Transcription } from './types';

/** Clips are cut here no matter what: the server budget assumes at most 5 minutes of audio. */
export const MAX_RECORDING_MS = 5 * 60 * 1000;
const POLL_MS = 1500;
/** Give up polling after this (a 5-minute clip on the CPU "medium" model takes ~100 s). */
const POLL_TIMEOUT_MS = 12 * 60 * 1000;

/** Container/codec the browser can record with: opus in webm (Chrome, Firefox) or mp4/aac (Safari). */
function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const t of ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4']) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined;
}

export const canRecordVoice = () =>
  typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;

/**
 * Microphone capture for one clip. `start()` asks for the mic (the browser prompts on first use),
 * `stop()` resolves with the encoded clip; `cancel()` drops it. The clip stops by itself at
 * MAX_RECORDING_MS (see onAutoStop).
 */
export class VoiceRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private limitTimer = 0;
  private stopped: ((blob: Blob) => void) | null = null;

  constructor(private readonly opts: { onAutoStop?: () => void } = {}) {}

  get active(): boolean {
    return this.recorder?.state === 'recording';
  }

  async start(): Promise<void> {
    if (this.recorder) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 48_000 } : undefined);
    this.stream = stream;
    this.recorder = recorder;
    this.chunks = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.chunks.push(ev.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      this.release();
      this.stopped?.(blob);
      this.stopped = null;
    };
    recorder.start(1000); // 1 s chunks: nothing is lost if the tab dies mid-clip
    this.limitTimer = window.setTimeout(() => {
      if (this.active) this.opts.onAutoStop?.();
    }, MAX_RECORDING_MS);
  }

  /** Ends the clip and resolves with the encoded audio. */
  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.recorder;
      if (!rec || rec.state === 'inactive') {
        this.release();
        return resolve(new Blob([], { type: 'audio/webm' }));
      }
      this.stopped = resolve;
      rec.stop();
    });
  }

  cancel(): void {
    const rec = this.recorder;
    this.stopped = null;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null;
      rec.stop();
    }
    this.release();
  }

  private release(): void {
    window.clearTimeout(this.limitTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

/** Uploads the clip and polls the job until the text is ready. Throws with a user-facing message. */
export async function transcribeClip(audio: Blob, signal?: AbortSignal): Promise<Transcription> {
  const { transcription: job } = await api.transcriptions.create(audio);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let current = job;
  while (current.status === 'pending') {
    if (signal?.aborted) throw new Error('Transcrição cancelada');
    if (Date.now() > deadline) throw new Error('A transcrição demorou demais');
    await new Promise((r) => setTimeout(r, POLL_MS));
    current = (await api.transcriptions.get(job.id)).transcription;
  }
  if (current.status === 'error') throw new Error(current.error || 'Falha ao transcrever o áudio');
  return current;
}
