import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { Composer } from './composer';

const mockVoice = {
  state: 'idle' as import('../viewmodel/use-voice').VoiceState,
  seconds: 0,
  level: null as number | null,
  error: null as string | null,
  notice: null as string | null,
  start: jest.fn(),
  stop: jest.fn(),
  cancel: jest.fn(),
};
let mockOnText: ((text: string) => void) | null = null;
jest.mock('../viewmodel/use-voice', () => ({
  useVoice: (onText: (text: string) => void) => {
    mockOnText = onText;
    return mockVoice;
  },
  useRecorder: () => ({ state: 'idle', seconds: 0, level: null, error: null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() }),
}));

async function renderComposer() {
  const onSend = jest.fn(async () => true);
  const view = await render(<Composer sending={false} onSend={onSend} uploadAttachment={jest.fn()} deleteAttachment={jest.fn()} />);
  return { onSend, rerender: () => view.rerender(<Composer sending={false} onSend={onSend} uploadAttachment={jest.fn()} deleteAttachment={jest.fn()} />) };
}

/** Moves the fake hook to `state` and renders again, as the real hook's state change would. */
async function voiceGoes(rerender: () => unknown, state: typeof mockVoice.state) {
  mockVoice.state = state;
  await act(async () => {
    rerender();
  });
}

/** The wave is decorative (hidden from accessibility), so the queries have to look at hidden elements. */
const HIDDEN = { includeHiddenElements: true };
const wave = () => screen.getByTestId('recording-wave', HIDDEN);
const barHeights = () => wave().children.map((bar) => (StyleSheet.flatten((bar as unknown as { props: { style: never } }).props.style) as { height: number }).height);

beforeEach(() => {
  Object.assign(mockVoice, { state: 'idle', seconds: 0, level: null, error: null, notice: null });
  mockVoice.start.mockClear();
  mockVoice.stop.mockClear();
  mockVoice.cancel.mockClear();
});

describe('Composer recording pill', () => {
  it('while recording the pill is ✕, the wave with its clock, ■ and ↑ — no +, no microphone, no plain send', async () => {
    mockVoice.state = 'recording';
    mockVoice.seconds = 7;
    await renderComposer();
    for (const name of ['Cancelar gravação', 'Parar', 'Parar e enviar']) expect(screen.getByRole('button', { name })).toBeEnabled();
    for (const name of ['Anexar', 'Ditar', 'Enviar']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(wave()).toBeTruthy();
    expect(screen.getByText('0:07')).toBeTruthy();
  });

  it('✕ drops the clip; ■ stops and the transcription lands in the box without sending', async () => {
    const { onSend, rerender } = await renderComposer();
    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'e depois');
    await voiceGoes(rerender, 'recording');
    await fireEvent.press(screen.getByRole('button', { name: 'Cancelar gravação' }));
    expect(mockVoice.cancel).toHaveBeenCalledTimes(1);

    await fireEvent.press(screen.getByRole('button', { name: 'Parar' }));
    expect(mockVoice.stop).toHaveBeenCalledTimes(1);
    await voiceGoes(rerender, 'transcribing');
    await act(() => mockOnText!('roda os testes'));
    await voiceGoes(rerender, 'idle');
    expect(screen.getByLabelText('Mensagem').props.value).toBe('e depois roda os testes');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('↑ stops and sends the box with the transcription once it arrives', async () => {
    const { onSend, rerender } = await renderComposer();
    await fireEvent.changeText(screen.getByLabelText('Mensagem'), 'no servidor,');
    await voiceGoes(rerender, 'recording');
    await fireEvent.press(screen.getByRole('button', { name: 'Parar e enviar' }));
    expect(mockVoice.stop).toHaveBeenCalledTimes(1);
    await voiceGoes(rerender, 'transcribing');
    expect(onSend).not.toHaveBeenCalled();
    await act(() => mockOnText!('roda os testes'));
    expect(onSend).toHaveBeenCalledWith('no servidor, roda os testes', []);
    expect(screen.getByLabelText('Mensagem').props.value).toBe('');
  });

  it('a ↑ whose clip brought no text sends nothing, and the next dictation is not sent either', async () => {
    const { onSend, rerender } = await renderComposer();
    await voiceGoes(rerender, 'recording');
    await fireEvent.press(screen.getByRole('button', { name: 'Parar e enviar' }));
    await voiceGoes(rerender, 'transcribing');
    await voiceGoes(rerender, 'idle'); // nothing heard: no text delivered

    await voiceGoes(rerender, 'recording');
    await fireEvent.press(screen.getByRole('button', { name: 'Parar' }));
    await voiceGoes(rerender, 'transcribing');
    await act(() => mockOnText!('só para a caixa'));
    await voiceGoes(rerender, 'idle');
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Mensagem').props.value).toBe('só para a caixa');
  });

  it('the wave turns dots into bars as the microphone level rises, newest on the right', async () => {
    const { rerender } = await renderComposer();
    mockVoice.level = 0;
    await voiceGoes(rerender, 'recording');
    expect(new Set(barHeights())).toEqual(new Set([4]));
    mockVoice.level = 1;
    await act(async () => {
      rerender();
    });
    const heights = barHeights();
    expect(heights[heights.length - 1]).toBe(22);
    expect(heights[0]).toBe(4);
  });

  it('with no level from the recorder the wave still moves, once a second', async () => {
    const { rerender } = await renderComposer();
    await voiceGoes(rerender, 'recording');
    const first = barHeights();
    mockVoice.seconds = 1;
    await act(async () => {
      rerender();
    });
    expect(barHeights()).not.toEqual(first);
  });
});
