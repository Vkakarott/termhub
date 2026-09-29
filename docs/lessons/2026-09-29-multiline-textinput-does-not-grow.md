---
symptom: "The chat composer's multiline TextInput stays one line tall while typing, on iOS and Android (onContentSizeChange never fires)"
tags: [mobile, react-native, textinput, fabric, yoga, layout]
evidence: observed
agent: claude
date: 2026-09-29
---
## Cause

The composer set the input's `height` from `onContentSizeChange`. On the new architecture iOS only
emits that event from `updateLayoutMetrics` (`RCTTextInputComponentView.mm`), i.e. when the input's
own layout changes — and an input held at a set height never gets a new layout, so the event that
would have grown it never came. Jest tests passed because they fired the event by hand.

A second trap waits behind the first: Yoga never lays out a measured child (a `TextInput`, a `Text`)
taller than a parent of a set height (`computeFlexBasisForChild` measures it as fit-content of the
parent's height unless the parent's `overflow` is `scroll`). An auto-sized input inside a frame whose
height is derived from the input's height cannot grow either.

## Fix

In `apps/mobile/src/features/chat/view/composer.tsx`: the input has no `height`, only `minHeight` and
`maxHeight` (it sizes itself to its text natively), it sits in an absolutely positioned wrapper with
no height (out of the fixed-height frame's flow), and the pill follows the input's `onLayout`.

## How to check

`npx jest src/features/chat/view/composer` in `apps/mobile`. On a phone: type a message that wraps —
the box grows a line at a time up to six, then scrolls, and is back to one line after sending. The
fix is covered by unit tests only; it was not yet confirmed on a device when this was written.
