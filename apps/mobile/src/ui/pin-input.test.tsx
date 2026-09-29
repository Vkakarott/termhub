import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Keyboard, Platform, TextInput } from 'react-native';
import { PAD_RETRY_MS, PinInput } from './pin-input';

// Under jest every `TextInput` shares these three (the preset's mock puts them on the prototype).
const field = TextInput.prototype as unknown as { focus: jest.Mock; blur: jest.Mock; isFocused: jest.Mock };
const addAppStateListener = AppState.addEventListener as unknown as jest.Mock;

/** What the field was told, in order. */
const calls: string[] = [];

/** The listener `PinInput` registered for the window getting the focus back (Android's `focus`). */
function windowFocusListener(): () => void {
  const call = addAppStateListener.mock.calls.find(([type]) => type === 'focus');
  if (!call) throw new Error('no AppState "focus" listener was registered');
  return call[1];
}

function on(os: 'ios' | 'android', { focused = true, padUp = false } = {}) {
  jest.replaceProperty(Platform, 'OS', os);
  field.isFocused.mockReturnValue(focused);
  jest.spyOn(Keyboard, 'isVisible').mockReturnValue(padUp);
}

beforeEach(() => {
  jest.useFakeTimers();
  calls.length = 0;
  field.focus.mockReset().mockImplementation(() => void calls.push('focus'));
  field.blur.mockReset().mockImplementation(() => void calls.push('blur'));
  field.isFocused.mockReset();
  addAppStateListener.mockClear();
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('PinInput', () => {
  it('asks the system number pad for the digits and reports only digits, at most six', async () => {
    const onChange = jest.fn();
    await render(<PinInput value="" onChange={onChange} accessibilityLabel="PIN" />);
    const input = screen.getByLabelText('PIN');
    expect(input.props.keyboardType).toBe('number-pad');
    expect(input.props.autoFocus).toBe(true);
    await fireEvent.changeText(input, '12a3 4567');
    expect(onChange).toHaveBeenLastCalledWith('123456');
  });

  it('is not editable while disabled, and asks for no keyboard', async () => {
    on('android', { focused: false });
    await render(<PinInput value="" onChange={jest.fn()} disabled accessibilityLabel="PIN" />);
    expect(screen.getByLabelText('PIN').props.editable).toBe(false);
    await fireEvent.press(screen.getByTestId('pin-input'));
    await act(() => jest.advanceTimersByTime(5_000));
    expect(calls).toEqual([]);
    expect(addAppStateListener).not.toHaveBeenCalled();
  });

  describe('on Android', () => {
    it('tapping the dots brings the number pad back to a field that kept the focus without it', async () => {
      // The pad is reported as up, so nothing but the tap asks for it.
      on('android', { padUp: true });
      await render(<PinInput value="" onChange={jest.fn()} accessibilityLabel="PIN" />);
      calls.length = 0;

      await fireEvent.press(screen.getByTestId('pin-input'));
      // A bare focus() would be dropped by React Native: the field still counts as focused.
      expect(calls).toEqual(['blur', 'focus']);
    });

    it('tapping the dots of a field without the focus only focuses it', async () => {
      on('android', { focused: false, padUp: true });
      await render(<PinInput value="" onChange={jest.fn()} accessibilityLabel="PIN" />);
      calls.length = 0;

      await fireEvent.press(screen.getByTestId('pin-input'));
      expect(calls).toEqual(['focus']);
    });

    it('asks for the pad again after it was mounted behind the biometric prompt', async () => {
      on('android');
      await render(<PinInput value="" onChange={jest.fn()} accessibilityLabel="PIN" />);
      expect(calls).toEqual(['focus']);
      calls.length = 0;

      await act(() => jest.advanceTimersByTime(PAD_RETRY_MS[0]!));
      expect(calls).toEqual(['blur', 'focus']);
      // Still no pad (the prompt took longer to leave): the later attempt asks once more.
      await act(() => jest.advanceTimersByTime(PAD_RETRY_MS[1]! - PAD_RETRY_MS[0]!));
      expect(calls).toEqual(['blur', 'focus', 'blur', 'focus']);
      // And that is all: it never keeps poking the keyboard.
      await act(() => jest.advanceTimersByTime(10_000));
      expect(calls).toHaveLength(4);
    });

    it('asks for the pad when the window gets the focus back', async () => {
      on('android', { padUp: true });
      await render(<PinInput value="" onChange={jest.fn()} accessibilityLabel="PIN" />);
      await act(() => jest.advanceTimersByTime(5_000));
      calls.length = 0;

      // The biometric prompt covered the app and took the pad with it; now it is gone.
      jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false);
      await act(() => windowFocusListener()());
      expect(calls).toEqual(['blur', 'focus']);
    });

    it('leaves the keyboard alone once the pad is up', async () => {
      on('android', { padUp: true });
      await render(<PinInput value="" onChange={jest.fn()} accessibilityLabel="PIN" />);
      calls.length = 0;

      await act(() => jest.advanceTimersByTime(5_000));
      await act(() => windowFocusListener()());
      await act(() => jest.advanceTimersByTime(5_000));
      expect(calls).toEqual([]);
    });

    it('leaves the keyboard alone while digits are being typed, whatever the keyboard events said', async () => {
      on('android');
      const view = await render(<PinInput value="" onChange={jest.fn()} accessibilityLabel="PIN" />);
      await view.rerender(<PinInput value="12" onChange={jest.fn()} accessibilityLabel="PIN" />);
      calls.length = 0;

      await act(() => jest.advanceTimersByTime(5_000));
      expect(calls).toEqual([]);
    });

    it('asks for the pad again when a lock ends, and stops asking once unmounted', async () => {
      on('android', { focused: false });
      const view = await render(<PinInput value="" onChange={jest.fn()} disabled accessibilityLabel="PIN" />);
      expect(calls).toEqual([]);

      await view.rerender(<PinInput value="" onChange={jest.fn()} accessibilityLabel="PIN" />);
      expect(calls).toEqual(['focus']);
      const stop = addAppStateListener.mock.results.at(-1)!.value.remove as jest.Mock;

      await view.unmount();
      calls.length = 0;
      await act(() => jest.advanceTimersByTime(5_000));
      expect(calls).toEqual([]);
      expect(stop).toHaveBeenCalled();
    });
  });

  describe('on iOS', () => {
    it('tapping the dots only focuses the field: the pad never leaves a focused field there', async () => {
      on('ios');
      await render(<PinInput value="" onChange={jest.fn()} accessibilityLabel="PIN" />);
      expect(calls).toEqual(['focus']);
      calls.length = 0;

      await fireEvent.press(screen.getByTestId('pin-input'));
      expect(calls).toEqual(['focus']);
      await act(() => jest.advanceTimersByTime(5_000));
      expect(calls).toEqual(['focus']);
      expect(addAppStateListener).not.toHaveBeenCalled();
    });
  });
});
