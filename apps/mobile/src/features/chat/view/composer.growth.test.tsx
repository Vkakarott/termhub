import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { getAnimatedStyle } from 'react-native-reanimated';
import { Composer } from './composer';

const mockVoice = { state: 'idle' as import('../viewmodel/use-voice').VoiceState, seconds: 0, error: null as string | null, notice: null as string | null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() };
jest.mock('../viewmodel/use-voice', () => ({
  useVoice: () => mockVoice,
  useRecorder: () => ({ state: 'idle', seconds: 0, error: null, start: jest.fn(), stop: jest.fn(), cancel: jest.fn() }),
}));

// No glide here: the frame is read where it lands (composer.motion.test.tsx looks at the motion).
jest.mock('react-native-reanimated', () => {
  const actual = jest.requireActual('react-native-reanimated');
  return { __esModule: true, ...actual, default: actual.default, useReducedMotion: () => true };
});

const LINE = 22;
const input = () => screen.getByLabelText('Mensagem');
const inputStyle = () => StyleSheet.flatten(input().props.style);
const frame = () => getAnimatedStyle(screen.getByTestId('composer-text')) as { height: number; marginBottom: number; marginLeft: number };
const slot = () => ({ ...StyleSheet.flatten(screen.getByTestId('composer-input-slot').props.style), ...getAnimatedStyle(screen.getByTestId('composer-input-slot')) });
const settle = () => act(() => jest.advanceTimersByTime(0));

/** The input laid out at `height`: what the platform reports once the text it sized itself to changed. */
async function laidOut(height: number) {
  await fireEvent(input(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height } } });
  await settle();
}

async function renderComposer(onSend = jest.fn(async () => true)) {
  await render(<Composer sending={false} onSend={onSend} uploadAttachment={jest.fn()} deleteAttachment={jest.fn()} />);
  await settle();
  return onSend;
}

describe('Composer growth', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockVoice.state = 'idle';
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('lets the input size itself: multiline, no height set, between one line and six', async () => {
    await renderComposer();
    expect(input().props.multiline).toBe(true);
    // A height set on the input is what kept it at one line: the platform only reports a new size
    // for an input whose layout changes, and one held at a set height never does.
    expect(inputStyle().height).toBeUndefined();
    expect(inputStyle()).toMatchObject({ minHeight: LINE, maxHeight: 6 * LINE });
    // Whatever the text, including after it grew.
    await fireEvent.changeText(input(), 'linha\n'.repeat(4));
    await laidOut(4 * LINE);
    expect(inputStyle().height).toBeUndefined();
    // And nothing depends on the content-size event any more.
    expect(input().props.onContentSizeChange).toBeUndefined();
  });

  it('keeps the input out of the frame\'s flow, so the frame\'s height never caps the input\'s', async () => {
    await renderComposer();
    expect(slot()).toMatchObject({ position: 'absolute', left: 0, right: 0 });
    expect(slot().height).toBeUndefined();
    expect(slot().bottom).toBeUndefined();
    expect(slot().maxHeight).toBeUndefined();
  });

  it('grows a line at a time as the text wraps, up to six lines, then scrolls', async () => {
    await renderComposer();
    expect(frame()).toMatchObject({ height: 36, marginBottom: 0 });
    expect(input().props.scrollEnabled).toBe(false);

    await fireEvent.changeText(input(), 'um texto que vai ficando mais comprido a cada palavra digitada');
    for (let lines = 2; lines <= 6; lines++) {
      await laidOut(lines * LINE);
      // The text on its own line (6 pt from the pill's top), the buttons' row kept free below.
      expect(frame()).toMatchObject({ height: 6 + lines * LINE, marginBottom: 40, marginLeft: 8 });
      expect(slot().top).toBe(6);
      expect(input().props.scrollEnabled).toBe(lines === 6);
    }
  });

  it('never grows past six lines, whatever the platform reports', async () => {
    await renderComposer();
    await fireEvent.changeText(input(), 'linha\n'.repeat(40));
    await laidOut(40 * LINE);
    expect(frame().height).toBe(6 + 6 * LINE);
    expect(input().props.scrollEnabled).toBe(true);
  });

  it('shrinks again as lines are erased', async () => {
    await renderComposer();
    await fireEvent.changeText(input(), 'linha\n'.repeat(5));
    await laidOut(5 * LINE);
    expect(frame().height).toBe(6 + 5 * LINE);

    await fireEvent.changeText(input(), 'linha\nlinha');
    await laidOut(2 * LINE);
    expect(frame().height).toBe(6 + 2 * LINE);
    expect(input().props.scrollEnabled).toBe(false);
  });

  it('is back to one line as soon as the message is sent', async () => {
    const onSend = await renderComposer();
    await fireEvent.changeText(input(), 'uma mensagem longa '.repeat(30));
    await laidOut(6 * LINE);
    expect(frame().height).toBe(6 + 6 * LINE);

    await fireEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    await settle();
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(input().props.value).toBe('');
    expect(frame()).toMatchObject({ height: 36, marginBottom: 0, marginLeft: 40 });
    expect(input().props.scrollEnabled).toBe(false);
  });

  it('grows for dictated text too', async () => {
    await renderComposer();
    // Dictation puts the transcription in the box like typing does; the input then lays itself out.
    await fireEvent.changeText(input(), 'um ditado comprido o bastante para quebrar em três linhas na caixa');
    await laidOut(3 * LINE);
    expect(frame()).toMatchObject({ height: 6 + 3 * LINE, marginBottom: 40 });
  });
});
