// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStream } from './chat';
import type { ChatEvent } from './types';

/** Minimal stand-in for the browser WebSocket: the test drives open/close by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  close() {}
  serverClose(code: number) {
    this.onclose?.({ code });
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1];

function Probe({ onReconnect, onEvent }: { onReconnect: () => void; onEvent: (e: ChatEvent) => void }) {
  useChatStream(onReconnect, onEvent);
  return null;
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useChatStream reconnect timing', () => {
  it('reopens the socket quickly after a 1012 close (server restarting)', () => {
    render(<Probe onReconnect={() => {}} onEvent={() => {}} />);
    expect(FakeSocket.all).toHaveLength(1);
    act(() => last().serverClose(1012));
    act(() => vi.advanceTimersByTime(760));
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('waits the full backoff after an ordinary close', () => {
    render(<Probe onReconnect={() => {}} onEvent={() => {}} />);
    act(() => last().serverClose(1006));
    act(() => vi.advanceTimersByTime(760));
    expect(FakeSocket.all).toHaveLength(1);
    act(() => vi.advanceTimersByTime(5000));
    expect(FakeSocket.all).toHaveLength(2);
  });
});
