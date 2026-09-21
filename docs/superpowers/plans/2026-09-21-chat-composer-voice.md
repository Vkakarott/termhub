# ChatGPT-shaped composer, dictation, and code blocks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the chat the composer the user asked for — one rounded box whose circular button dictates when it is empty and sends when it is not — and make an answer's code blocks readable and copyable.

**Architecture:** Three pieces, each independently testable. A `useDictation` hook wraps the voice stack the terminals already use (`VoiceRecorder`, `transcribeClip`, `voiceStore`, `GET /transcriptions/config`) into a state machine the chat can render; `ChatComposer` becomes a two-row container that changes its primary button's role with the state; and `ChatTurn` decorates each code block with a header and a copy button **after** sanitisation, so nothing the model writes can forge one.

**Tech Stack:** React 18, Tailwind 3, Vitest + @testing-library/react, the existing `apps/web/src/lib/voice-recorder.ts` and `voice-store.ts`. No new dependencies, no server change.

**Spec:** none written; the design was agreed in conversation from the user's own screenshots of ChatGPT's mobile app, and is restated in Global Constraints below. Where this plan and a screenshot disagree, the plan wins — the screenshots are a reference for shape, not a specification to copy.

## Global Constraints

- **No new dependencies.** No icon library: the three glyphs (arrow, microphone, square) are inline SVG in the component that uses them.
- **No server change.** `POST /transcriptions`, `GET /transcriptions/:id` and `GET /transcriptions/config` already exist and are used by the terminals; this plan only calls them.
- UI copy in pt-BR; code, comments, commit messages and PR text in English.
- Tailwind tokens only for colours (`bg`, `bg-2`…`bg-4`, `fg`, `fg-muted`, `fg-dim`, `line`, `accent`, `warn`, `danger`, `ok`, `attention`); no hex literals.
- **The existing tests are the contract.** `npm test -w @termhub/web` is 27 files / 250 tests green on `main` at the start of this plan and must stay green; no test may be deleted or weakened to make a change pass. The Enter policy (`enterSends()`), the placeholder "Pergunte ou peça algo às suas máquinas", the "Enviar" affordance and the autosize behaviour are all asserted today.
- **`apps/web/src/components/Terminal.tsx` is not being refactored.** One exception, spelled out in Task 1: its local `micErrorMessage` moves into `voice-recorder.ts` and Terminal imports it instead. Nothing else in that file is touched.
- **Dictation never sends.** The transcribed text lands in the box for the person to read and send. The concierge acts on real machines and a transcription mishears a project name; this is the same rule the terminals follow (paste, never execute).
- Green means `npm test -w @termhub/web`, `npm run typecheck --workspaces --if-present`, and `npm run build -w @termhub/web`.

## Review Focus

- **A denied or absent microphone.** `getUserMedia` rejects (permission denied, no device, insecure context) — the composer must say so in pt-BR and return to a usable state, never sit in "recording" with no recorder. (Task 1.)
- **A clip with nothing in it.** A tap that starts and stops the recorder in under a second produces a few hundred bytes; uploading it wastes a job and returns nothing. It must go back to idle without an error that reads like a failure. (Task 1.)
- **The transcription failing or timing out** after the audio was recorded — the text is gone either way, so the message must say that plainly rather than leaving the box empty and silent. (Task 1.)
- **A code fence whose language the model chose.** The language string is model-written text that ends up in a header; inserted raw it is an HTML injection *after* the sanitiser has already run. (Task 3.)
- **A browser with no `navigator.clipboard`** (older Safari, or an insecure context): the copy button must not throw, and must not claim success. (Task 3.)

---

### Task 1: `useDictation` — the voice state machine, out of the terminal and into a hook

**Files:**
- Create: `apps/web/src/lib/use-dictation.ts`
- Create: `apps/web/src/lib/use-dictation.test.tsx`
- Modify: `apps/web/src/lib/voice-recorder.ts` (gains `micErrorMessage`, moved verbatim from `Terminal.tsx`)
- Modify: `apps/web/src/components/Terminal.tsx` (deletes its local `micErrorMessage`, imports it instead — the only change to this file)

**Interfaces:**
- Consumes: `VoiceRecorder`, `canRecordVoice`, `transcribeClip`, `MAX_RECORDING_MS`, `Clip` from `./voice-recorder`; `api.transcriptions.config()`.
- Produces:
  ```ts
  export type DictationState = 'off' | 'idle' | 'recording' | 'uploading' | 'transcribing';
  export interface Dictation {
    state: DictationState;
    /** whole seconds recorded so far, for the timer; 0 unless recording */
    seconds: number;
    /** pt-BR, already user-facing; cleared by the next start() */
    error: string | null;
    start: () => void;
    /** stop and transcribe; the text is delivered through `onText` */
    stop: () => void;
    /** drop the clip, no upload */
    cancel: () => void;
  }
  export function useDictation(onText: (text: string) => void): Dictation;
  ```
  Task 2 renders exactly this.

- [ ] **Step 1: Write the failing tests**

`use-dictation.test.tsx` (`// @vitest-environment jsdom`), driving the hook with `@testing-library/react`'s `renderHook` and `act`, mocking `../lib/voice-recorder` and `../lib/api` so no real microphone or network is involved. The module mock must let each test decide what `VoiceRecorder.start` and `stop` do.

1. It reports `off` when `canRecordVoice()` is false — the button must not be offered at all on a browser that cannot record.
2. It reports `off` when the server says transcription is disabled (`api.transcriptions.config()` resolves `{ enabled: false }`), and `idle` when it resolves `{ enabled: true }`.
3. `start()` moves it to `recording`, and `seconds` follows the recorder's own clock (advance fake timers and assert the number the timer shows).
4. A `getUserMedia` rejection leaves it `idle` with a pt-BR `error` — assert the message for a `NotAllowedError` names permission.
5. `stop()` with a clip under 2048 bytes returns to `idle` and sets **no** error: nothing was said, and an error there reads like a failure that did not happen.
6. `stop()` with a real clip goes `uploading` → `transcribing` → `idle`, and calls `onText` once with the transcribed text.
7. A `transcribeClip` rejection leaves it `idle` with the thrown message as `error` — the audio is gone, so silence would be the worst outcome.
8. `cancel()` during a recording returns to `idle`, calls the recorder's `cancel`, and never calls `transcribeClip`.
9. The recorder's `onAutoStop` (the five-minute cut) behaves exactly like `stop()`.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/web -- use-dictation` — expect a module-not-found error.

- [ ] **Step 3: Implement the hook**

Read `apps/web/src/components/Terminal.tsx`'s voice section first (its `VoiceState`, `startVoice`/`stopVoice`/`cancelVoice`, `MIN_CLIP_BYTES`, `micErrorMessage`) and carry over the behaviour that was learned there, including the 2048-byte floor and the auto-stop wiring. The store key is `'chat'` (the `tabId` parameter of `VoiceRecorder`/`transcribeClip` is a storage key, not a tab — say so in a comment, since the name will mislead the next reader). Keep the hook free of anything visual: no strings that belong to the composer's layout, only the error messages.

- [ ] **Step 4: Move `micErrorMessage`**

Cut it from `Terminal.tsx` into `voice-recorder.ts`, export it, import it in both consumers. No behaviour change, no other edit to `Terminal.tsx`.

- [ ] **Step 5: Green and commit**

`npm test -w @termhub/web`, `npm run typecheck --workspaces --if-present`.

```bash
git add apps/web/src/lib/use-dictation.ts apps/web/src/lib/use-dictation.test.tsx apps/web/src/lib/voice-recorder.ts apps/web/src/components/Terminal.tsx
git commit -m "Web: the terminals' dictation state machine, as a hook the chat can use"
```

---

### Task 2: The composer, in the shape the user asked for

**Files:**
- Modify: `apps/web/src/components/chat/ChatComposer.tsx`
- Create: `apps/web/src/components/chat/ChatComposer.dictation.test.tsx`
- Modify: `apps/web/src/components/chat/ChatComposer.test.tsx` (the existing behaviour, re-asserted against the new markup)
- Modify: `apps/web/src/pages/ChatPage.tsx` (only if the composer's props change)

**Interfaces:**
- Consumes: `useDictation` (Task 1), `enterSends` from `./lib/chat-scroll`.
- Produces: the same `ChatComposerProps` as today (`value`, `onChange`, `onSend`, `sending`) — the dictation lives inside the composer, because nothing above it needs to know.

**The shape**, from the user's screenshots, mapped to what this product has:

- One rounded container (`rounded-2xl`, `border-line`, `bg-bg-2`) holding two rows: the textarea on top, borderless and transparent, and an action row beneath it.
- The action row is right-aligned and holds **one** circular primary button, 40px, whose role follows the state: **microphone** when the box is empty, **arrow up** when it has text, **square (stop)** while recording. There is no second mic button — an empty box is the mic, which is what "vazio = ditar, com texto = enviar" means.
- While recording, the row also shows, to the left of the button: a pulsing dot in `attention`, the elapsed time as `m:ss`, and a text button "cancelar".
- While uploading or transcribing, the row shows "transcrevendo…" and the primary button is disabled.
- The dictation's `error`, when set, shows under the row in `danger`, small.
- When `useDictation` reports `off`, an empty box simply has a disabled arrow button — no microphone is offered, and nothing explains why (a browser that cannot record is not a fault the person can fix from here).

- [ ] **Step 1: Write the failing tests**

In the new `ChatComposer.dictation.test.tsx`, mocking `../../lib/use-dictation` so each test hands the component a state:

1. Empty box, dictation `idle` → the button's accessible name is about dictating ("Ditar"), and clicking it calls `start`.
2. Box with text, dictation `idle` → the accessible name is about sending ("Enviar"), and clicking it calls `onSend`, not `start`.
3. Dictation `recording` → the name is about stopping ("Parar"), the elapsed time is on screen as `m:ss` (give it 65 seconds and assert `1:05`), and a "cancelar" button calls `cancel`.
4. Dictation `transcribing` → "transcrevendo…" is on screen and the primary button is disabled.
5. Dictation `off`, empty box → there is no dictate button at all; the primary is the send button, disabled.
6. `error` set → the message is on screen.
7. The transcribed text reaches the box: the hook's `onText` callback, when called, results in `onChange` being called with the existing text plus the transcription (assert the join: a box that already says "olha" and a transcription of "isso aqui" must produce "olha isso aqui", not "olhaisso aqui" — decide the separator and pin it).

In the existing `ChatComposer.test.tsx`, keep every current assertion passing against the new markup: the placeholder, Enter sending on a fine pointer, Enter not sending on a coarse one, the autosize floor, and the `scrollTop` comment's caveat. Where a query has to change (the button is now found by accessible name rather than by the text "Enviar"), change the query, not the assertion.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/web -- ChatComposer`.

- [ ] **Step 3: Build it**

Inline SVG for the three glyphs, each with `aria-hidden` and the accessible name on the button itself. The textarea keeps its autosize, its Enter policy and its safe-area padding; its floor drops to one row, since the box is now visibly a box without needing two.

- [ ] **Step 4: Green and commit**

`npm test -w @termhub/web`, `npm run typecheck --workspaces --if-present`, `npm run build -w @termhub/web`.

```bash
git add apps/web/src/components/chat apps/web/src/pages/ChatPage.tsx
git commit -m "Chat: one box that dictates when empty and sends when it is not"
```

---

### Task 3: Code blocks with a header and a copy button

**Files:**
- Create: `apps/web/src/lib/code-blocks.ts`
- Create: `apps/web/src/lib/code-blocks.test.ts`
- Modify: `apps/web/src/components/chat/ChatTurn.tsx`
- Modify: `apps/web/src/components/chat/ChatTurn.test.tsx`
- Modify: `apps/web/src/index.css` (styles for the header, beside `.prose-termhub`)

**Interfaces:**
- Consumes: the sanitised HTML string `renderMarkdown` returns.
- Produces:
  ```ts
  /** Wraps each `<pre>` in a figure with a header (language name + copy button). Input must already be sanitised. */
  export function decorateCodeBlocks(html: string): string;
  /** The label for a fence's language class, or null when there is none to trust. */
  export function codeLanguage(className: string | null): string | null;
  ```

- [ ] **Step 1: Write the failing tests**

`code-blocks.test.ts` (`// @vitest-environment jsdom`):

1. A fence with `class="language-bash"` gains a header whose text is `bash`, and the `<pre>` survives inside the wrapper with its content unchanged.
2. A fence with no language gains a header reading `código`.
3. **The language is model-written text.** `codeLanguage('language-<img src=x onerror=alert(1)>')` returns null (or a sanitised token), and `decorateCodeBlocks` never emits that string into the header — assert against the parsed DOM that no `img` and no `onerror` exist. This runs **after** the sanitiser, so it is the one place where model text could re-enter the document unchecked: keep only `[a-z0-9+#-]{1,20}`, case-insensitive, and fall back to `código`.
4. A `<pre>` that is not a code fence (no `<code>` child) is left alone.
5. Prose without any `<pre>` comes back unchanged.
6. Running it twice does not nest two headers (a re-render must be idempotent).

In `ChatTurn.test.tsx`:

7. An answer with a fence shows the language header and a copy button whose accessible name says copying.
8. Clicking copy calls `navigator.clipboard.writeText` with exactly the code's text — no header text, no trailing marker.
9. With `navigator.clipboard` undefined, clicking does not throw and the button does not claim it copied.

- [ ] **Step 2: Run them and watch them fail**

`npm test -w @termhub/web -- code-blocks ChatTurn`.

- [ ] **Step 3: Implement**

`decorateCodeBlocks` parses with `DOMParser`, wraps, and serialises — no regex over HTML. In `ChatTurn`, compose it with `renderMarkdown` inside the existing `useMemo`, and handle the click with **one delegated handler** on the prose container (`closest('[data-copy]')`, then read the sibling `<pre>`'s `textContent`), so no per-block React node is needed. The button gets a transient "copiado" state; with no clipboard API, it reports failure instead.

- [ ] **Step 4: Style**

A header bar above the block: same border and radius family as `.prose-termhub pre`, muted text for the language, the copy button quiet until hover/focus. Keep it in `index.css` beside the existing prose rules.

- [ ] **Step 5: Green and commit**

`npm test -w @termhub/web`, `npm run typecheck --workspaces --if-present`, `npm run build -w @termhub/web`.

```bash
git add apps/web/src/lib/code-blocks.ts apps/web/src/lib/code-blocks.test.ts apps/web/src/components/chat apps/web/src/index.css
git commit -m "Chat: a header and a copy button on every code block"
```
