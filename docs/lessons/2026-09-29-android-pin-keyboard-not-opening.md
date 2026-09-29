---
symptom: "Android: the number pad does not open on the PIN field after the biometric prompt, and tapping the field does nothing"
tags: [mobile, android, keyboard, textinput, biometrics]
evidence: observed
agent: claude
date: 2026-09-29
---
## Cause

Two things that only meet on Android:

- Android opens the soft keyboard only for a window that has the focus. `PinInput` is mounted (with
  `autoFocus`) while the window does not have it yet: behind the biometric prompt that was just
  cancelled, in a `Modal` still sliding in, on a cold start. The field gets the focus, the keyboard
  request is dropped.
- React Native's `TextInputState.focusTextInput` is a no-op for the input it already counts as
  focused. After the keyboard is gone (the case above, the back button, a system dialog) the field
  still counts as focused, so `ref.focus()` — what tapping the PIN dots did — never reaches the
  native side again.

iOS restores the keyboard of a focused field by itself, so it never showed there.

## Fix

In `apps/mobile/src/ui/pin-input.tsx`, on Android only: blur a focused field before focusing it
(`if (field.isFocused()) field.blur(); field.focus()`), and ask for the pad again shortly after the
field took focus and whenever the window gets the focus back (`AppState`'s `focus` event), unless
the keyboard is visible or digits are already in the field.

## How to check

`npx jest src/ui/pin-input.test.tsx` in `apps/mobile`. On a phone: Desbloquear → "Usar biometria" →
cancel the prompt: the number pad is up; dismiss it with the back button and tap the dots: it opens
again. The fix is covered by unit tests only; it was not yet confirmed on a device when this was
written.
