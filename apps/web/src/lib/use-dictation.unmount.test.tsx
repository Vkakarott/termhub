// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The one dictation test that does NOT mock `./voice-recorder`. What is under test is the microphone
 * itself being released after the component is gone, and a mocked recorder can only show that a
 * function was called — so the real `VoiceRecorder` runs here against a stubbed `getUserMedia` and a
 * stubbed `MediaRecorder`, and the assertion is that the stream's own track was stopped.
 */
const mocks = vi.hoisted(() => ({
  config: vi.fn(async () => ({ enabled: true })),
  store: { begin: vi.fn(), append: vi.fn(), update: vi.fn(), clear: vi.fn() },
}));

vi.mock('./api', () => ({ api: { transcriptions: { config: mocks.config } } }));
vi.mock('./voice-store', () => ({ voiceStore: mocks.store }));

/** Just enough of the interface `VoiceRecorder` uses; `isTypeSupported` says no, so no mimeType is passed. */
class FakeMediaRecorder {
  static isTypeSupported = () => false;
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    public stream: unknown,
    public options?: unknown,
  ) {}
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.onstop?.();
  }
}

/** The live microphone track: `stop()` on it is what actually turns the phone's recording indicator off. */
let track: { stop: ReturnType<typeof vi.fn> };
/** Grants the permission the browser is still asking about. */
let grantMic: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  track = { stop: vi.fn() };
  grantMic = () => {};
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(
        () =>
          new Promise((resolve) => {
            grantMic = () => resolve({ getTracks: () => [track] });
          }),
      ),
    },
  });
  mocks.config.mockResolvedValue({ enabled: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useDictation, unmounted mid-start', () => {
  it('releases the microphone the browser granted after the component was already gone', async () => {
    vi.resetModules();
    const { useDictation } = await import('./use-dictation');
    const { result, unmount } = renderHook(() => useDictation(vi.fn()));
    await act(async () => {}); // GET /transcriptions/config
    expect(result.current.state).toBe('idle');

    act(() => {
      result.current.start();
    });
    expect(result.current.state).toBe('starting');

    // The permission sheet is still up, so `VoiceRecorder` has no `MediaRecorder` inside it yet: the
    // unmount cleanup runs against a recorder that has nothing to stop.
    unmount();
    expect(track.stop).not.toHaveBeenCalled();

    await act(async () => {
      grantMic();
    });

    // The stream opened with nobody left to close it. Before the fix the track stayed live — on a
    // phone the recording indicator stays lit until the 5-minute cap — and the 500 ms clock interval
    // was installed with no cleanup left to clear it.
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
