import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { MAX_RECORDING_MS, VoiceRecorder, canRecordVoice, micErrorMessage, transcribeClip, type Clip, type TranscribePhase } from './voice-recorder';
import { voiceStore } from './voice-store';

/**
 * Voice input: checking whether it is available at all, off (server has no whisper / browser can't
 * record), idle, starting the mic, recording a clip, sending it, waiting for the text.
 *
 * `checking` is the first state every instance reports, and it exists for the UI's sake: telling
 * `off` from `idle` needs one round trip to the server, and a composer that assumed `off` until the
 * answer arrived flashed a disabled send button before turning into a microphone on first paint.
 *
 * `starting` is the browser's own permission sheet being up: `getUserMedia` has been called and has
 * not settled, so there is no recorder yet and nothing can be recorded or stopped. It is public for
 * two reasons — a button that looks ready while nothing is listening lies, and a prompt the person
 * never answers must leave a state the UI can see instead of a hidden flag that wedges this hook
 * until the page is reloaded.
 */
export type DictationState = 'checking' | 'off' | 'idle' | 'starting' | 'recording' | 'uploading' | 'transcribing';

export interface Dictation {
  state: DictationState;
  /** whole seconds recorded so far, for the timer; 0 unless recording */
  seconds: number;
  /** pt-BR, already user-facing; cleared by the next start() */
  error: string | null;
  /**
   * pt-BR feedback that is not a failure: a clip too short to hold speech, a transcription that came
   * back with no words. Kept apart from `error` because neither is a fault — the plan forbids an
   * error for the short clip — and silence for both is indistinguishable from a broken microphone.
   * Cleared by the next start().
   */
  notice: string | null;
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
  const [state, setStateValue] = useState<DictationState>('checking');
  /** mirrors `state` for the closures below (recorder callbacks fire outside React's render cycle) */
  const stateRef = useRef<DictationState>('checking');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    // Only while still `checking`, so a late answer can never overwrite a state the hook has already
    // moved on to (nothing can leave `checking` today — `start()` needs `idle` — but this is the one
    // write that comes from outside the state machine, and it stays confined to the state it owns).
    void isVoiceEnabled().then((ok) => {
      if (alive && stateRef.current === 'checking') setState(ok ? 'idle' : 'off');
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
        const text = result.text ?? '';
        // Whisper answers an empty string for a clip it heard nothing in. Delivering that would leave
        // the box exactly as it was, with "transcrevendo…" having come and gone for no visible reason.
        if (text.trim()) {
          setNotice(null);
          onTextRef.current(text);
        } else {
          setNotice('Nenhuma fala reconhecida');
        }
        void voiceStore.clear('chat'); // text delivered: the stored audio has done its job
      } catch (err) {
        // NOT cleared here: a failed upload/transcription is exactly what the store exists to
        // survive (a refresh can still recover the audio) — do not "tidy" this away.
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
        // Too short to be speech. Not an error — nothing failed, the person let go too early — but not
        // silence either: the same wording the terminals use, carried as a notice.
        void voiceStore.clear('chat'); // nothing worth keeping
        setNotice('Gravação muito curta');
        setState('idle');
        return;
      }
      void runTranscription(clip);
    });
  }, [runTranscription, setState]);

  const start = useCallback(() => {
    if (stateRef.current !== 'idle') return;
    setError(null);
    setNotice(null);
    // onAutoStop reuses `stop()` itself (not a parallel path) so the 5-minute cut behaves exactly
    // like the user clicking stop: same upload, same transcription, same error handling.
    const rec = new VoiceRecorder('chat', { onAutoStop: () => stop() });
    recorderRef.current = rec;
    // Blocks a second start while the prompt is open, exactly as the hidden ref used to — but this
    // one is the state the composer renders, so the button is a disabled microphone for as long as
    // the sheet is up, and a sheet that is never answered leaves the hook somewhere it can be seen.
    setState('starting');
    void rec
      .start()
      .then(() => {
        // The mic only opened now. If this hook has moved on — unmounted, or cancelled — the cleanup
        // that ran while `rec` still had no MediaRecorder inside it stopped nothing, so this is the
        // only place left that can close the stream. Install no clock: nothing is left to clear it.
        // `cancel()` and not `cancel(true)`: nothing in the chat reads the stored clip back (see the
        // note on the 'chat' key below), so there is nothing to keep it for.
        if (recorderRef.current !== rec) {
          rec.cancel();
          return;
        }
        setState('recording');
        setSeconds(0);
        const startedAt = Date.now();
        stopClock();
        clockTimer.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt) / 1000)), 500);
      })
      .catch((err: unknown) => {
        // Same guard, nothing to close: the mic was never opened, so a hook that has moved on has
        // nothing to undo and no state left to report this in.
        if (recorderRef.current !== rec) return;
        recorderRef.current = null;
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

  return { state, seconds, error, notice, start, stop, cancel };
}

// Re-exported so callers (the chat composer) can show the 5-minute cap without importing voice-recorder.ts directly.
export { MAX_RECORDING_MS };
