import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View, type NativeSyntheticEvent, type TextInputContentSizeChangeEventData } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { MAX_ATTACHMENTS_PER_MESSAGE, type TChatAttachment } from '@/services/api/contract';
import { Icon, type IconName } from '@/ui';
import { CHAT_MSG } from '../model/messages';
import { useAttachmentDrafts, type PickedFile } from '../viewmodel/attachments';
import { useVoice } from '../viewmodel/use-voice';
import { AttachmentChip } from './attachment-chip';
import { AttachmentSheet } from './attachment-sheet';

/** The box's line box for 16 px text; its height follows the content between `MIN_ROWS` and
 * `MAX_ROWS` of these (the web composer's names), and past that it scrolls. */
const LINE_HEIGHT = 22;
const MIN_ROWS = 1;
const MAX_ROWS = 6;
const MIN_HEIGHT = LINE_HEIGHT * MIN_ROWS;
const MAX_HEIGHT = LINE_HEIGHT * MAX_ROWS;
/** The buttons' row (`h-9`), and the pill's padding around its content (`px-1 py-1.5`). */
const ROW_HEIGHT = 36;
const PILL_X = 4;
const PILL_Y = 6;
/** A button and the gap next to it: how far the text keeps off each side while it shares the row. */
const BESIDE = ROW_HEIGHT + 4;
/** Where the text starts on its own line, and the gap between it and the buttons' row. */
const TEXT_INSET = 8;
const TEXT_TOP = 6;
const ROW_GAP = 4;
/** The pill growing a line, or the text moving between the buttons' line and its own: ChatGPT's glide. */
const GLIDE = { duration: 220, easing: Easing.out(Easing.cubic), reduceMotion: ReduceMotion.System };

/**
 * The text's frame inside the pill. The buttons' row is pinned to the pill's bottom in both layouts;
 * sharing it, the text sits between 📎 and the round button, centred on the row; on its own, it takes
 * the whole width and keeps the row free below. The pill's height is whatever this frame adds up to.
 */
function textFrame(stacked: boolean, height: number) {
  return stacked
    ? { left: TEXT_INSET, right: TEXT_INSET, top: TEXT_TOP, height: TEXT_TOP + height, below: ROW_HEIGHT + ROW_GAP }
    : { left: BESIDE, right: BESIDE, top: (ROW_HEIGHT - LINE_HEIGHT) / 2, height: ROW_HEIGHT, below: 0 };
}

/** A number that glides to each new target, or jumps there when the system asks for reduced motion. */
function useGlide(target: number, still: boolean): SharedValue<number> {
  const value = useSharedValue(target);
  useEffect(() => {
    value.set(still ? target : withTiming(target, GLIDE));
  }, [target, still, value]);
  return value;
}

/** The number of chips 📎 stops at. */
const MAX_CHIPS = MAX_ATTACHMENTS_PER_MESSAGE;

/** What the single round button does right now. Exactly one of these, in every state. */
type PrimaryRole = 'dictate' | 'send' | 'stop';

const PRIMARY_LABEL: Record<PrimaryRole, string> = { dictate: 'Ditar', send: 'Enviar', stop: 'Parar' };
const PRIMARY_ICON: Record<PrimaryRole, IconName> = {
  dictate: { ios: 'mic', android: 'mic' },
  send: { ios: 'arrow.up', android: 'arrow_upward' },
  stop: { ios: 'stop.fill', android: 'stop' },
};
const ATTACH_ICON: IconName = { ios: 'paperclip', android: 'attach_file' };

/**
 * Appends a transcription to whatever is already in the box — the web's `appendDictated`, verbatim.
 * Whisper returns its own leading/trailing spaces, so the clip is trimmed and a single space is
 * inserted, except when the box is empty (no leading space) or already ends in whitespace, where the
 * separator the person typed is kept exactly. A clip that trims away to nothing leaves the box alone.
 */
export function appendDictated(current: string, text: string): string {
  const clip = text.trim();
  if (!clip) return current;
  if (!current) return clip;
  return /\s$/.test(current) ? current + clip : `${current} ${clip}`;
}

/** Whole seconds as `m:ss` — 65 reads as `1:05`, the way a stopwatch is read. */
const formatClock = (total: number) => `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;

type Props = {
  sending: boolean;
  /** Resolves `true` once the server accepted the message: the chips clear then (the text cleared already). */
  onSend(text: string, attachments: TChatAttachment[]): Promise<boolean>;
  uploadAttachment(file: PickedFile, onProgress: (fraction: number) => void): Promise<TChatAttachment>;
  deleteAttachment(id: string): Promise<void>;
  /** The store's `attachmentStatuses`: what the socket heard for each upload, so a chip moves on from "processando…". */
  attachmentStatuses?: Readonly<Record<string, TChatAttachment>>;
};

/**
 * The message box (chat redesign spec §4.2 "Composer", attachments spec 2026-09-26 §5.6): one rounded
 * pill holding the attachment chips on top and a `TextInput` whose height follows its content between
 * `MIN_ROWS` and `MAX_ROWS` lines. While the text fits on one line, 📎, the text and the one round
 * button sit side by side; once it wraps (or while recording, or with a status to show) the text takes
 * the pill's whole width and the buttons get a row of their own under it, inside the pill — the web
 * composer's "one box, two rows". The buttons' row stays pinned to the pill's bottom, next to the
 * keyboard: the pill grows upwards and the text glides between the two places (`GLIDE`), line by
 * line, unless the system asks for reduced motion. The round button is a microphone with nothing typed and no chips, the send arrow with
 * text or chips, a stop square while recording, the web's rules. Nothing leaves while a chip is still uploading, and nothing leaves
 * with a chip the server could not read (it would answer 409): the line says to remove it. The text
 * clears as soon as it is sent and comes back if the send fails; the chips only go once the server
 * accepted. The status, error and notice lines are always mounted, so text appearing in them moves
 * nothing.
 */
export function Composer({ sending, onSend, uploadAttachment, deleteAttachment, attachmentStatuses }: Props) {
  const [text, setText] = useState('');
  const [height, setHeight] = useState(MIN_HEIGHT);
  // Latched: once the text wraps the buttons stay below until the box is emptied. Leaving as soon as
  // the text fit on one line again would flap, since the text gets wider when the buttons move out.
  const [wrapped, setWrapped] = useState(false);
  const [picking, setPicking] = useState(false);
  const voice = useVoice(useCallback((clip: string) => setText((current) => appendDictated(current, clip)), []));
  const attachments = useAttachmentDrafts({ upload: uploadAttachment, remove: deleteAttachment, statuses: attachmentStatuses });

  const hasText = text.trim().length > 0;
  /** A chip that is (or will be) part of the message: uploading or uploaded; a refused one is not. */
  const hasChips = attachments.drafts.some((d) => d.phase !== 'failed');
  const invalid = attachments.invalid.length > 0;
  const canSend = (hasText || attachments.uploaded.length > 0) && !attachments.uploading && !invalid && !sending;

  // The box empties at once (the row is already on screen) and gets its text back if the send
  // fails — unless something new was typed meanwhile, which is the person's to keep. The chips stay
  // until the server accepted, and only the ones this send carried go: one picked meanwhile is the
  // next message's.
  const submit = async () => {
    if (!canSend) return;
    const sent = text;
    const carried = attachments.drafts.filter((d) => d.phase === 'uploaded' && d.attachment !== null);
    changeText('');
    if (await onSend(sent, carried.map((d) => d.attachment!))) attachments.clear(carried.map((d) => d.key));
    else setText((current) => current || sent);
  };

  // An emptied box (sent, or erased) is back to one line at once, without waiting for the native
  // size event; the returned text of a failed send is measured again by the input.
  const changeText = (next: string) => {
    setText(next);
    if (next === '') {
      setHeight(MIN_HEIGHT);
      setWrapped(false);
    }
  };

  const onContentSizeChange = (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
    const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(e.nativeEvent.contentSize.height)));
    setHeight(next);
    if (next > MIN_HEIGHT) setWrapped(true);
  };

  /** The clip is on its way to the server: nothing else can be done with the box's content yet. */
  const busy = voice.state === 'uploading' || voice.state === 'transcribing';
  // Recording outranks the text: a box that is listening stops, it never sends mid-sentence. With
  // nothing typed and no chips the button dictates — unless dictation is off, where the empty box
  // keeps the (disabled) send button. While `checking` or `starting` it is the microphone, disabled.
  const role: PrimaryRole = voice.state === 'recording' ? 'stop' : hasText || hasChips || voice.state === 'off' ? 'send' : 'dictate';
  const disabled = role === 'stop' ? false : role === 'send' ? !canSend || busy : busy || voice.state === 'checking' || voice.state === 'starting';
  const statusText = busy
    ? 'transcrevendo…'
    : attachments.uploading
      ? CHAT_MSG.attachmentUploading
      : invalid
        ? CHAT_MSG.attachmentInvalid
        : (attachments.notice ?? '');
  const onPrimary = role === 'stop' ? voice.stop : role === 'send' ? () => void submit() : voice.start;
  // No 📎 while dictation holds the microphone or its clip: the sheet's recorder would release the
  // audio session under it (one recorder at a time), and five chips is the message's limit.
  const attachOff = attachments.drafts.length >= MAX_CHIPS || voice.state === 'starting' || voice.state === 'recording' || busy;

  // The status line needs the row's middle, which the text covers while it shares the row.
  const stacked = wrapped || voice.state === 'recording' || statusText !== '';
  const still = useReducedMotion();
  const frame = textFrame(stacked, height);
  const left = useGlide(frame.left, still);
  const right = useGlide(frame.right, still);
  const top = useGlide(frame.top, still);
  const boxHeight = useGlide(frame.height, still);
  const below = useGlide(frame.below, still);
  const textStyle = useAnimatedStyle(() => ({
    marginLeft: left.get(),
    marginRight: right.get(),
    paddingTop: top.get(),
    height: boxHeight.get(),
    marginBottom: below.get(),
  }));

  const attach = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Anexar"
      accessibilityState={{ disabled: attachOff }}
      disabled={attachOff}
      onPress={() => setPicking(true)}
      hitSlop={8}
      className={`h-9 w-9 items-center justify-center rounded-full ${attachOff ? 'opacity-50' : ''}`}
    >
      <Icon name={ATTACH_ICON} size={20} tone="muted" />
    </Pressable>
  );
  const status = statusText ? (
    <Text className="shrink text-xs text-app-muted" numberOfLines={1}>
      {statusText}
    </Text>
  ) : null;
  // Send and stop are the filled circle (the text colour, so it inverts with the theme); the
  // microphone is a plain symbol, like the one next to an empty ChatGPT box.
  const filled = role !== 'dictate';
  const primary = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={PRIMARY_LABEL[role]}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPrimary}
      hitSlop={4}
      className={`h-9 w-9 items-center justify-center rounded-full ${filled ? 'bg-app-text' : ''} ${disabled ? 'opacity-40' : ''}`}
    >
      <Icon name={PRIMARY_ICON[role]} size={filled ? 16 : 20} tone={filled ? 'bg' : 'text'} />
    </Pressable>
  );

  return (
    <View className="bg-app-bg px-3 pb-2 pt-2">
      <View className="rounded-3xl bg-app-surface2 px-1 py-1.5">
        {attachments.drafts.length > 0 ? (
          <View className="mb-2 mt-1 gap-2 px-1">
            {attachments.drafts.map((d) => (
              <AttachmentChip key={d.key} draft={d} onRemove={() => attachments.remove(d.key)} onRetry={() => attachments.retry(d.key)} />
            ))}
          </View>
        ) : null}
        {/* Always mounted, in this order: the row under the text, so where the two meet (the row's
            empty middle while they share it) the input takes the touch. Nothing here is swapped
            between the layouts, so the input is never remounted: the keyboard stays up and the
            caret where it was. */}
        <View
          pointerEvents="box-none"
          style={{ position: 'absolute', left: PILL_X, right: PILL_X, bottom: PILL_Y, height: ROW_HEIGHT }}
          className="flex-row items-center gap-2"
        >
          {attach}
          {/* While recording the row shows the clip is listening, for how long, and lets it be dropped. */}
          <View pointerEvents="box-none" className="flex-1 flex-row items-center gap-2">
            {voice.state === 'recording' ? (
              <>
                <View className="h-2 w-2 rounded-full bg-app-danger" />
                <Text className="text-xs text-app-text">{formatClock(voice.seconds)}</Text>
                <Pressable accessibilityRole="button" accessibilityLabel="Cancelar gravação" onPress={voice.cancel} className="px-2 py-1">
                  <Text className="text-xs text-app-muted">cancelar</Text>
                </Pressable>
              </>
            ) : null}
          </View>
          {status}
          {primary}
        </View>
        <Animated.View testID="composer-text" style={[{ overflow: 'hidden' }, textStyle]}>
          <TextInput
            value={text}
            onChangeText={changeText}
            placeholder="Mensagem"
            accessibilityLabel="Mensagem"
            multiline
            onContentSizeChange={onContentSizeChange}
            scrollEnabled={height >= MAX_HEIGHT}
            textAlignVertical="top"
            // No padding of its own (Android adds some by default, iOS some to a multiline input) and
            // no extra font padding: the height set here is exactly the lines it shows. It takes its
            // new height at once; the frame around it glides, and clips it meanwhile.
            style={{ height, lineHeight: LINE_HEIGHT, fontSize: 16, padding: 0, paddingTop: 0, paddingBottom: 0, includeFontPadding: false }}
            className="text-app-text placeholder:text-app-muted"
          />
        </Animated.View>
      </View>
      <Text className="h-4 px-1 text-xs text-app-danger" numberOfLines={1}>
        {voice.error ?? ''}
      </Text>
      <Text className="h-4 px-1 text-xs text-app-muted" numberOfLines={1}>
        {voice.notice ?? ''}
      </Text>
      <AttachmentSheet open={picking} room={Math.max(0, MAX_CHIPS - attachments.drafts.length)} onClose={() => setPicking(false)} onPicked={attachments.add} />
    </View>
  );
}
