import { useCallback, useEffect, useRef } from 'react';
import { AppState, Keyboard, Platform, Pressable, TextInput } from 'react-native';
import { PinDots } from './pin-dots';

type Props = {
  value: string;
  onChange(value: string): void;
  length?: number;
  disabled?: boolean;
  error?: boolean;
  accessibilityLabel: string;
};

/** Android only: how long after the field took focus the number pad is asked for again, in case the
 * first ask came before the window could show it. */
export const PAD_RETRY_MS = [300, 1000];

/** A PIN typed on the system number pad: the dots are what shows, over a hidden field that holds
 * the digits. Tapping the dots brings the keyboard back; the field takes focus again whenever it is
 * re-enabled (a lock ends, a wrong PIN was cleared).
 *
 * Android needs more than a `focus()` for that. It only opens the pad for a window that has the
 * focus, and the field is often mounted before that: behind the biometric prompt that was just
 * cancelled, in a sheet still sliding in, on a cold start. The field keeps the focus but has no pad,
 * and React Native drops a `focus()` on the field it already counts as focused — so there the field
 * is blurred first, and the pad is asked for again once the window is back. */
export function PinInput({ value, onChange, length = 6, disabled = false, error = false, accessibilityLabel }: Props) {
  const input = useRef<TextInput>(null);
  /** Digits in the field: the pad is up and being used, whatever the keyboard events said. */
  const digits = useRef(value.length);
  digits.current = value.length;

  const summon = useCallback(() => {
    const field = input.current;
    if (!field) return;
    if (Platform.OS === 'android' && field.isFocused()) field.blur();
    field.focus();
  }, []);

  useEffect(() => {
    if (disabled) return;
    input.current?.focus();
    if (Platform.OS !== 'android') return;

    let timers: ReturnType<typeof setTimeout>[] = [];
    const summonIfMissing = () => {
      if (!Keyboard.isVisible() && digits.current === 0) summon();
    };
    const retry = () => {
      timers.forEach(clearTimeout);
      timers = PAD_RETRY_MS.map((ms) => setTimeout(summonIfMissing, ms));
    };
    retry();
    // The window has the focus again (the biometric prompt, or any system dialog, is gone).
    const windowFocus = AppState.addEventListener('focus', () => {
      summonIfMissing();
      retry();
    });
    return () => {
      timers.forEach(clearTimeout);
      windowFocus.remove();
    };
  }, [disabled, summon]);

  return (
    <Pressable accessible={false} testID="pin-input" className="py-4" onPress={disabled ? undefined : summon}>
      <PinDots length={length} filled={value.length} error={error} />
      <TextInput
        ref={input}
        value={value}
        onChangeText={(text) => onChange(text.replace(/\D/g, '').slice(0, length))}
        editable={!disabled}
        autoFocus={!disabled}
        keyboardType="number-pad"
        maxLength={length}
        autoComplete="off"
        autoCorrect={false}
        textContentType="none"
        caretHidden
        contextMenuHidden
        accessibilityLabel={accessibilityLabel}
        className="absolute h-px w-px opacity-0"
      />
    </Pressable>
  );
}
