import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { MAX_RECORDING_MS, VoiceRecorder, canRecordVoice, micErrorMessage, transcribeClip, type Clip, type TranscribePhase } from './voice-recorder';

/** Voice input: off (server has no whisper / browser can't record), idle, recording a clip, sending it, waiting for the text. */
export type DictationState = 'off' | 'idle' | 'recording' | 'uploading' | 'transcribing';

export interface Dictation {
  state: DictationState;
  /** whole seconds recorded so far, for the timer; 0 unless recording */
  seconds: number;
  /** pt-BR, already user-facing; cleared by the next start() */
  error: string | null;
  start: () => void;
  /** stop and transcribe; the text is delivered through `onText` */
  stop: () => void;
  /** drop the clip, no upload */
  cancel: () => void;
}

/** Below this size (~0.3 s of opus) there is nothing to transcribe. */
const MIN_CLIP_BYTES = 2048;

/** Whether the server transcribes audio — asked once per page load, shared by every hook instance (same caching as Terminal.tsx used to do locally). */
let voiceEnabled: Promise<boolean> | null = null;
function isVoiceEnabled(): Promise<boolean> {
  if (!canRecordVoice()) return Promise.resolve(false);
  voiceEnabled ??= api.transcriptions
    .config()
    .then((c) => c.enabled)
    .catch(() => false);
  return voiceEnabled;
}

/**
 * The dictation state machine that used to live inline in Terminal.tsx: record a clip, upload it,
 * poll for the transcription, hand the text back through `onText`. Lifted into a hook so the chat
 * composer can drive the exact same pipeline the terminal already relies on.
 */
export function useDictation(onText: (text: string) => void): Dictation {
  const [state, setStateValue] = useState<DictationState>('off');
  /** mirrors `state` for the closures below (recorder callbacks fire outside React's render cycle) */
  const stateRef = useRef<DictationState>('off');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const clockTimer = useRef(0);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  const setState = useCallback((s: DictationState) => {
    stateRef.current = s;
    setStateValue(s);
  }, []);

  useEffect(() => {
    let alive = true;
    void isVoiceEnabled().then((ok) => {
      if (alive && ok && stateRef.current === 'off') setState('idle');
    });
    return () => {
      alive = false;
    };
  }, [setState]);

  const stopClock = () => {
    window.clearInterval(clockTimer.current);
    clockTimer.current = 0;
  };

  const runTranscription = useCallback(
    async (clip: Clip) => {
      const onPhase = (p: TranscribePhase) => setState(p.phase);
      try {
        // 'chat' is the IndexedDB storage key VoiceRecorder/transcribeClip save the clip under (so
        // a refresh mid-recording can recover it) — despite the `tabId` parameter name, it is not a tab.
        const result = await transcribeClip('chat', clip, onPhase);
        setError(null);
        onTextRef.current(result.text ?? '');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Falha ao transcrever o áudio');
      } finally {
        setState('idle');
      }
    },
    [setState],
  );

  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || stateRef.current !== 'recording') return;
    stopClock();
    setSeconds(0); // `seconds` is documented as 0 unless recording
    setState('uploading');
    recorderRef.current = null;
    void rec.stop().then((clip) => {
      if (clip.audio.size < MIN_CLIP_BYTES) {
        // too short to be speech: return to idle quietly, this isn't a failure worth reporting
        setState('idle');
        return;
      }
      void runTranscription(clip);
    });
  }, [runTranscription, setState]);

  const start = useCallback(() => {
    if (stateRef.current !== 'idle') return;
    setError(null);
    // onAutoStop reuses `stop()` itself (not a parallel path) so the 5-minute cut behaves exactly
    // like the user clicking stop: same upload, same transcription, same error handling.
    const rec = new VoiceRecorder('chat', { onAutoStop: () => stop() });
    recorderRef.current = rec;
    stateRef.current = 'recording'; // block a second start while the mic prompt is open
    void rec
      .start()
      .then(() => {
        setState('recording');
        setSeconds(0);
        const startedAt = Date.now();
        stopClock();
        clockTimer.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500);
      })
      .catch((err: unknown) => {
        recorderRef.current = null;
        stateRef.current = 'idle';
        setState('idle');
        setError(micErrorMessage(err));
      });
  }, [setState, stop]);

  const cancel = useCallback(() => {
    recorderRef.current?.cancel();
    recorderRef.current = null;
    stopClock();
    setSeconds(0); // `seconds` is documented as 0 unless recording
    setState('idle');
  }, [setState]);

  // Unmount mid-recording (composer closed, tab switched away): free the mic, keep the audio in
  // IndexedDB (VoiceRecorder.cancel(true)) — mirrors Terminal.tsx's own unmount cleanup.
  useEffect(
    () => () => {
      recorderRef.current?.cancel(true);
      recorderRef.current = null;
      stopClock();
    },
    [],
  );

  return { state, seconds, error, start, stop, cancel };
}

// Re-exported so callers (the chat composer) can show the 5-minute cap without importing voice-recorder.ts directly.
export { MAX_RECORDING_MS };
