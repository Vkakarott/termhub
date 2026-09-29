---
symptom: "Mobile chat: a markdown quote (>) shows as an almost white box with unreadable text in the dark theme"
tags: [mobile, markdown, theme, dark-mode, react-native-markdown-display]
evidence: observed
card: TER-436
agent: claude
date: 2026-09-29
---
## Cause

`react-native-markdown-display` merges the `style` prop over its own styles, node by node, and its
own are written for a white page: `blockquote` on `#F5F5F5`, `code_inline` / `code_block` / `fence`
on `#f5f5f5`, `hr`, `table` and `tr` lines in `#000000`. The app's style
(`apps/mobile/src/features/chat/view/markdown-style.ts`) only set `body`, `code_inline`, `fence` and
`link`, so a quote kept the library's light background under the theme's light text. Nothing showed
in tests: under jest the package is replaced by a plain `Text` (`test/fakes/markdown.js`).

## Fix

Set every colour the library sets, from the palette, in `markdown-style.ts` (`blockquote`,
`code_block`, `hr`, `table`, `tr`, `blocklink`, and the border of the code nodes).
`markdown-style.test.tsx` compares the two lists, so a node the library colours and the app does not
fails the test, and renders quotes with the real renderer (`jest.requireActual`).

## How to check

`npx jest src/features/chat/view/markdown-style` in `apps/mobile`. On a phone, in the dark theme: an
answer with a `>` quote shows it on a dark surface with readable text. The fix is covered by unit
tests only; it was not yet confirmed on a device when this was written.
