// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shared mock state for `./voice-recorder`. One recorder "instance" is enough: every test starts
 * at most one recording, and `vi.hoisted` keeps this reachable from both the `vi.mock` factory
 * (which runs before imports) and the test bodies below.
 */
const mocks = vi.hoisted(() => {
  const recorder = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => ({ audio: new Blob(['0'.repeat(3000)]), seconds: 3 })),
    cancel: vi.fn(),
    lastOpts: null as { onAutoStop?: () => void } | null,
  };
  class MockVoiceRecorder {
    constructor(
      public tabId: string,
      opts: { onAutoStop?: () => void } = {},
    ) {
      recorder.lastOpts = opts;
    }
    start() {
      return recorder.start();
    }
    stop() {
      return recorder.stop();
    }
    cancel(keepStored?: boolean) {
      return recorder.cancel(keepStored);
    }
  }
  return {
    recorder,
    MockVoiceRecorder,
    canRecordVoice: vi.fn(() => true),
    transcribeClip: vi.fn(async () => ({ text: 'hello' })),
    configEnabled: vi.fn(async () => ({ enabled: true })),
  };
});

vi.mock('./voice-recorder', () => ({
  canRecordVoice: mocks.canRecordVoice,
  transcribeClip: mocks.transcribeClip,
  MAX_RECORDING_MS: 5 * 60 * 1000,
  VoiceRecorder: mocks.MockVoiceRecorder,
  // pt-BR, same wording as the real voice-recorder.ts — the hook only needs to know the name matches.
  micErrorMessage: (err: unknown) => ((err as { name?: string })?.name === 'NotAllowedError' ? 'Permissão do microfone negada' : 'Não foi possível acessar o microfone'),
}));

vi.mock('./api', () => ({
  api: { transcriptions: { config: mocks.configEnabled } },
}));

/** Reloads the module fresh so its module-level `isVoiceEnabled()` cache doesn't leak between tests. */
async function load() {
  vi.resetModules();
  return import('./use-dictation');
}

async function boot() {
  const { useDictation } = await load();
  const onText = vi.fn();
  const rendered = renderHook(() => useDictation(onText));
  await act(async () => {}); // flush the canRecordVoice/config effect
  return { ...rendered, onText };
}

/** Drives `start()` and flushes the recorder's `start()` promise so the hook settles into `recording`. */
async function startRecording(result: ReturnType<typeof boot> extends Promise<{ result: infer R }> ? R : never) {
  act(() => {
    result.current.start();
  });
  await act(async () => {});
}

beforeEach(() => {
  mocks.recorder.start.mockReset().mockImplementation(async () => {});
  mocks.recorder.stop.mockReset().mockImplementation(async () => ({ audio: new Blob(['0'.repeat(3000)]), seconds: 3 }));
  mocks.recorder.cancel.mockReset();
  mocks.recorder.lastOpts = null;
  mocks.canRecordVoice.mockReset().mockReturnValue(true);
  mocks.transcribeClip.mockReset().mockResolvedValue({ text: 'hello' });
  mocks.configEnabled.mockReset().mockResolvedValue({ enabled: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useDictation', () => {
  it('reports off when canRecordVoice() is false', async () => {
    mocks.canRecordVoice.mockReturnValue(false);
    const { useDictation } = await load();
    const { result } = renderHook(() => useDictation(vi.fn()));
    expect(result.current.state).toBe('off');
    await act(async () => {});
    expect(result.current.state).toBe('off');
    expect(mocks.configEnabled).not.toHaveBeenCalled();
  });

  it('reports off when the server has transcription disabled, idle when enabled', async () => {
    mocks.configEnabled.mockResolvedValue({ enabled: false });
    const { useDictation } = await load();
    const offRender = renderHook(() => useDictation(vi.fn()));
    await act(async () => {});
    expect(offRender.result.current.state).toBe('off');

    mocks.configEnabled.mockResolvedValue({ enabled: true });
    const { useDictation: useDictation2 } = await load();
    const idleRender = renderHook(() => useDictation2(vi.fn()));
    await act(async () => {});
    expect(idleRender.result.current.state).toBe('idle');
  });

  it('start() moves it to recording, and seconds follows the clock', async () => {
    vi.useFakeTimers();
    const { result } = await boot();
    await startRecording(result);
    expect(result.current.state).toBe('recording');
    act(() => {
      vi.advanceTimersByTime(2500);
    });
    expect(result.current.seconds).toBe(2);
  });

  it('a getUserMedia rejection leaves it idle with a pt-BR permission error', async () => {
    const { result } = await boot();
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    mocks.recorder.start.mockRejectedValueOnce(err);
    await startRecording(result);
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toMatch(/permiss/i);
  });

  it('stop() with a clip under 2048 bytes returns to idle and sets no error', async () => {
    const { result } = await boot();
    await startRecording(result);
    mocks.recorder.stop.mockResolvedValueOnce({ audio: new Blob(['x']), seconds: 1 });
    act(() => {
      result.current.stop();
    });
    await act(async () => {});
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBeNull();
    expect(mocks.transcribeClip).not.toHaveBeenCalled();
  });

  it('stop() with a real clip goes uploading -> transcribing -> idle and calls onText once', async () => {
    const { result, onText } = await boot();
    await startRecording(result);

    let onPhaseCapture: ((p: unknown) => void) | null = null;
    let resolveTranscribe: ((v: { text: string }) => void) | null = null;
    mocks.transcribeClip.mockImplementationOnce((_key: string, _clip: unknown, onPhase: (p: unknown) => void) => {
      onPhaseCapture = onPhase;
      onPhase({ phase: 'uploading', fraction: 1 });
      return new Promise((resolve) => {
        resolveTranscribe = resolve;
      });
    });

    act(() => {
      result.current.stop();
    });
    await act(async () => {});
    expect(result.current.state).toBe('uploading');

    act(() => {
      onPhaseCapture?.({ phase: 'transcribing', eta: null, progress: 0 });
    });
    expect(result.current.state).toBe('transcribing');

    await act(async () => {
      resolveTranscribe?.({ text: 'hello world' });
    });
    expect(result.current.state).toBe('idle');
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith('hello world');
  });

  it('a transcribeClip rejection leaves it idle with the thrown message as error', async () => {
    const { result } = await boot();
    await startRecording(result);
    mocks.transcribeClip.mockRejectedValueOnce(new Error('Falha ao transcrever o áudio'));
    act(() => {
      result.current.stop();
    });
    await act(async () => {});
    expect(result.current.state).toBe('idle');
    expect(result.current.error).toBe('Falha ao transcrever o áudio');
  });

  it('cancel() during a recording returns to idle, calls the recorder cancel, never transcribes', async () => {
    const { result } = await boot();
    await startRecording(result);
    act(() => {
      result.current.cancel();
    });
    expect(result.current.state).toBe('idle');
    expect(mocks.recorder.cancel).toHaveBeenCalledTimes(1);
    expect(mocks.transcribeClip).not.toHaveBeenCalled();
  });

  it("the recorder's onAutoStop behaves exactly like stop()", async () => {
    const { result, onText } = await boot();
    await startRecording(result);
    act(() => {
      mocks.recorder.lastOpts?.onAutoStop?.();
    });
    await act(async () => {});
    expect(result.current.state).toBe('idle');
    expect(mocks.recorder.stop).toHaveBeenCalledTimes(1);
    expect(mocks.transcribeClip).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledTimes(1);
  });
});
