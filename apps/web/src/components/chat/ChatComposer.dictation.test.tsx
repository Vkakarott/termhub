// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dictation, DictationState } from '../../lib/use-dictation';

const start = vi.fn();
const stop = vi.fn();
const cancel = vi.fn();
const onChange = vi.fn();
const onSend = vi.fn();

/** What the mocked hook hands the component on the next render. */
let dictation: Dictation;
/** The `onText` callback the component gave the hook — the only way a transcription arrives. */
let deliverText: ((text: string) => void) | null = null;

vi.mock('../../lib/use-dictation', () => ({
  useDictation: (onText: (text: string) => void) => {
    deliverText = onText;
    return dictation;
  },
}));

import { ChatComposer } from './ChatComposer';

function renderComposer(opts: { state?: DictationState; value?: string; sending?: boolean; seconds?: number; error?: string | null } = {}) {
  dictation = { state: opts.state ?? 'idle', seconds: opts.seconds ?? 0, error: opts.error ?? null, start, stop, cancel };
  return render(<ChatComposer value={opts.value ?? ''} onChange={onChange} onSend={onSend} sending={opts.sending ?? false} />);
}

/** The one circular button on the right of the action row, whichever role it currently has. */
function primary(name: RegExp): HTMLButtonElement {
  return screen.getByRole('button', { name }) as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  deliverText = null;
});

beforeEach(() => {
  deliverText = null;
});

describe('ChatComposer dictation', () => {
  it('offers the microphone, and only the microphone, when the box is empty', () => {
    renderComposer({ state: 'idle', value: '' });

    // One button with one role: an empty box dictates, so there is no send affordance to find.
    expect(screen.queryByRole('button', { name: /enviar/i })).toBeNull();
    fireEvent.click(primary(/ditar/i));

    expect(start).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('turns into the send button as soon as there is text', () => {
    renderComposer({ state: 'idle', value: 'olha' });

    expect(screen.queryByRole('button', { name: /ditar/i })).toBeNull();
    fireEvent.click(primary(/enviar/i));

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('while recording: stops, shows the clock as m:ss, and can be cancelled', () => {
    renderComposer({ state: 'recording', value: '', seconds: 65 });

    // 65 raw seconds on screen would be a stopwatch nobody can read: the assertion is the format.
    expect(screen.getByText('1:05')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /ditar/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /cancelar/i }));
    expect(cancel).toHaveBeenCalledTimes(1);

    fireEvent.click(primary(/parar/i));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('recording wins over the text already in the box', () => {
    renderComposer({ state: 'recording', value: 'olha', seconds: 3 });

    // Exactly one role per state: a box with text that is also recording still stops, never sends.
    expect(screen.queryByRole('button', { name: /enviar/i })).toBeNull();
    expect(primary(/parar/i).disabled).toBe(false);
  });

  it('shows a disabled microphone while the hook is still checking, never a send arrow', () => {
    renderComposer({ state: 'checking', value: '' });

    // `checking` lasts one round trip, and dictation is what an empty box is about to offer: a send
    // arrow for that instant, swapped for a mic when /config answers, is a flicker on first paint.
    expect(screen.queryByRole('button', { name: /enviar/i })).toBeNull();
    expect(primary(/ditar/i).disabled).toBe(true);
  });

  it('says it is transcribing, disables the primary button, and offers no cancel', () => {
    renderComposer({ state: 'transcribing', value: '' });

    // A wait nobody can see must be a wait a screen reader hears.
    expect(screen.getByRole('status').textContent).toMatch(/transcrevendo/i);
    expect(primary(/ditar/i).disabled).toBe(true);
    // `cancel()` cannot stop an upload that is already on its way — offering it here would lie.
    expect(screen.queryByRole('button', { name: /cancelar/i })).toBeNull();
  });

  it('offers no microphone at all when dictation is off', () => {
    renderComposer({ state: 'off', value: '' });

    expect(screen.queryByRole('button', { name: /ditar/i })).toBeNull();
    // Just the ordinary empty-box send button, disabled, with nothing explaining the absence.
    expect(primary(/enviar/i).disabled).toBe(true);
  });

  it('shows the dictation error, and announces it', () => {
    renderComposer({ state: 'idle', value: '', error: 'Permissão do microfone negada' });

    expect(screen.getByText('Permissão do microfone negada')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Permissão do microfone negada');
  });

  it('keeps every glyph decorative: the accessible name is on the button, never on the svg', () => {
    const roles: Array<[{ state: DictationState; value: string }, RegExp]> = [
      [{ state: 'checking', value: '' }, /ditar/i],
      [{ state: 'idle', value: '' }, /ditar/i],
      [{ state: 'idle', value: 'olha' }, /enviar/i],
      [{ state: 'recording', value: '' }, /parar/i],
    ];

    for (const [opts, name] of roles) {
      const { container } = renderComposer(opts);
      const button = primary(name);

      const glyphs = Array.from(container.querySelectorAll('svg'));
      expect(glyphs).toHaveLength(1);
      for (const glyph of glyphs) {
        expect(glyph.getAttribute('aria-hidden')).toBe('true');
        expect(glyph.getAttribute('aria-label')).toBeNull();
        expect(glyph.querySelector('title')).toBeNull();
      }
      // The button carries the name itself, and has no text for a name to fall back to: moving the
      // name onto the glyph tomorrow would leave the button with nothing to be called.
      expect(button.getAttribute('aria-label')).toMatch(name);
      expect(button.textContent).toBe('');
      cleanup();
    }
  });

  it('appends the transcription to what is already typed, with a space between', () => {
    renderComposer({ state: 'idle', value: 'olha' });

    act(() => deliverText!('isso aqui'));

    expect(onChange).toHaveBeenCalledWith('olha isso aqui');
  });

  it('puts the keyboard back in the box when the transcription lands', () => {
    renderComposer({ state: 'idle', value: 'olha' });
    const box = screen.getByPlaceholderText(/pergunte/i);
    // Where a keyboard user is standing when the text arrives: on the stop button, which is disabled
    // the moment the upload starts, so the browser has already dropped focus to `body`.
    (screen.getByRole('button', { name: /enviar/i }) as HTMLButtonElement).focus();
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);

    act(() => deliverText!('isso aqui'));

    expect(document.activeElement).toBe(box);
  });

  it('does not invent whitespace the box already has, and does not lose a newline', () => {
    renderComposer({ state: 'idle', value: '' });
    act(() => deliverText!('isso aqui'));
    expect(onChange).toHaveBeenLastCalledWith('isso aqui'); // an empty box gets no leading space
    cleanup();

    renderComposer({ state: 'idle', value: 'olha ' });
    act(() => deliverText!(' isso aqui '));
    expect(onChange).toHaveBeenLastCalledWith('olha isso aqui'); // one space, not three
    cleanup();

    renderComposer({ state: 'idle', value: 'olha\n' });
    act(() => deliverText!('isso aqui'));
    expect(onChange).toHaveBeenLastCalledWith('olha\nisso aqui'); // the person's own line break survives
    cleanup();

    onChange.mockClear();
    renderComposer({ state: 'idle', value: 'olha' });
    act(() => deliverText!('   '));
    expect(onChange).not.toHaveBeenCalled(); // a silent clip changes nothing
  });
});
