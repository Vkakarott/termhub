import { useLocalSearchParams, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activeGrantsLabel } from '@/features/chat-grants/model/labels';
import type { TTabQuestionAnswerBody } from '@/services/api/contract';
import { AppText, Banner, Button, EmptyState, Screen, Sheet } from '@/ui';
import { activeGrantIndex, isGrantActive } from '../model/grant-time';
import { isActive } from '../model/subagents';
import { chatTimeline, groupPendingActions, type ChatEntry } from '../model/timeline';
import type { ChatMessage } from '../model/types';
import type { ChatDecision } from '../viewmodel/createChatStore';
import { useChatStore } from '../viewmodel/useChatStore';
import { ActionCard } from './action-card';
import { ActionGroupCard } from './action-group-card';
import { Composer } from './composer';
import { HostLine } from './host-line';
import { MessageBubble } from './message-bubble';
import { SubagentsSheet } from './subagents-sheet';
import { TabQuestionCard } from './tab-question-card';
import { TabSuggestionCard } from './tab-suggestion-card';

/** How often the grant index re-checks expiry (spec §4.2 "Stable rows"): never during render. */
const GRANT_TICK_MS = 30_000;
/** How often the subagents sheet's elapsed labels refresh while it is open (spec 2026-09-26 panel §4). */
const SUBAGENTS_TICK_MS = 30_000;

const entryKey = (entry: ChatEntry) =>
  entry.kind === 'message'
    ? `m:${entry.message.id}`
    : entry.kind === 'action'
      ? `a:${entry.action.id}`
      : entry.kind === 'action_group'
        ? `g:${entry.actions[0]!.id}`
        : entry.kind === 'tab_suggestion'
          ? `s:${entry.suggestion.id}`
          : `q:${entry.question.id}`;

/** One message row, subscribed to its own streamed text (spec §4.2 "Incremental fold"): a delta
 * re-renders this row and nothing else — `renderItem` and `extraData` do not change for it.
 * Every started row waits, not only the newest: with queued or injected turns several answers can be
 * pending at once (spec 2026-09-26 concierge always free), and a process that dies closes its open
 * turns with a reason, so a leftover reads as the failure it is. */
const MessageRow = memo(function MessageRow({ message }: { message: ChatMessage }) {
  const streamed = useChatStore((s) => s.live.deltas.get(message.id));
  const started = useChatStore((s) => s.live.started.has(message.id));
  const retrySend = useChatStore((s) => s.retrySend);
  const onRetry = useCallback((id: string) => void retrySend(id), [retrySend]);
  return <MessageBubble message={message} streamed={streamed} started={started} onRetry={onRetry} />;
});

/** The conversation (spec §11.2): thread, action cards, the host line when the host needs attention,
 * the trusted tabs and composer.
 * The route param is a conversation id (a deep link), a project id or `general` — the store
 * resolves which. */
export function ConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const openByRoute = useChatStore((s) => s.openByRoute);
  const activeProject = useChatStore((s) => s.activeProject);
  const slot = useChatStore((s) => (s.activeProject === undefined ? undefined : s.conversations[s.activeProject ?? '']));
  const projects = useChatStore((s) => s.projects);
  const error = useChatStore((s) => s.error);
  const sending = useChatStore((s) => s.sending);
  const decidingId = useChatStore((s) => s.decidingId);
  const send = useChatStore((s) => s.send);
  const uploadAttachment = useChatStore((s) => s.uploadAttachment);
  const deleteAttachment = useChatStore((s) => s.deleteAttachment);
  const attachmentStatuses = useChatStore((s) => s.attachmentStatuses);
  const decide = useChatStore((s) => s.decide);
  const decideMany = useChatStore((s) => s.decideMany);
  const revokingId = useChatStore((s) => s.revokingId);
  const revokeGrant = useChatStore((s) => s.revokeGrant);
  const answeringQuestionIds = useChatStore((s) => s.answeringQuestionIds);
  const questionErrors = useChatStore((s) => s.questionErrors);
  const answerTabQuestion = useChatStore((s) => s.answerTabQuestion);
  const loadTabQuestionScreen = useChatStore((s) => s.loadTabQuestionScreen);
  const busySuggestionIds = useChatStore((s) => s.busySuggestionIds);
  const suggestionErrors = useChatStore((s) => s.suggestionErrors);
  const forgetDecision = useChatStore((s) => s.forgetDecision);
  const sendTabSuggestion = useChatStore((s) => s.sendTabSuggestion);
  const dismissTabSuggestion = useChatStore((s) => s.dismissTabSuggestion);
  const reset = useChatStore((s) => s.reset);
  const cancelSubagent = useChatStore((s) => s.cancelSubagent);
  const [confirmingReset, setConfirmingReset] = useState(false);
  /** "Ver separadas" holds only for the cards it was clicked on: a new or decided card groups again. */
  const [separate, setSeparate] = useState(false);
  const insets = useSafeAreaInsets();
  /** Where the keyboard-avoiding view's parent starts on screen; `null` until measured. */
  const bodyRef = useRef<View>(null);
  const [bodyTop, setBodyTop] = useState<number | null>(null);
  const measureBody = useCallback(() => bodyRef.current?.measureInWindow((_x, y) => setBodyTop(y)), []);

  // The subagents panel (spec 2026-09-26 panel §4): always closable — the header button stays up
  // while it is open (even once every subagent has ended), the sheet has its own close control
  // (`Sheet`'s backdrop), and "Nova conversa" closes it too, below.
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const subagents = useMemo(() => slot?.subagents ?? [], [slot?.subagents]);
  const cancelFailed = useMemo(() => slot?.cancelFailed ?? [], [slot?.cancelFailed]);
  const activeSubagents = useMemo(() => subagents.filter(isActive), [subagents]);
  const [subagentsNow, setSubagentsNow] = useState(() => Date.now());
  useEffect(() => {
    if (!subagentsOpen) return;
    const timer = setInterval(() => setSubagentsNow(Date.now()), SUBAGENTS_TICK_MS);
    return () => clearInterval(timer);
  }, [subagentsOpen]);
  const onCancelSubagent = useCallback((id: string) => void cancelSubagent(id), [cancelSubagent]);

  useEffect(() => {
    if (id) void openByRoute(id);
  }, [id, openByRoute]);

  const messages = slot?.messages;
  const actions = slot?.actions;
  const grants = useMemo(() => slot?.grants ?? [], [slot?.grants]);
  const projectGrants = useMemo(() => slot?.projectGrants ?? [], [slot?.projectGrants]);
  const activeGrantCount = useMemo(() => grants.filter((g) => isGrantActive(g)).length + projectGrants.filter((g) => isGrantActive(g)).length, [grants, projectGrants]);
  const tabQuestions = slot?.tabQuestions;
  const tabSuggestions = slot?.tabSuggestions;

  // The grants still in force, by the card that created them: built when `grants`/`projectGrants`
  // change and every 30 s while there are any (a grant runs out on its own), never inside a row's render.
  const [grantTick, setGrantTick] = useState(0);
  useEffect(() => {
    if (grants.length === 0 && projectGrants.length === 0) return;
    const timer = setInterval(() => setGrantTick((t) => t + 1), GRANT_TICK_MS);
    return () => clearInterval(timer);
  }, [grants.length, projectGrants.length]);
  // `grantTick` is a dependency on purpose: it is what re-checks expiry.
  const grantIndex = useMemo(() => activeGrantIndex(grants), [grants, grantTick]);
  const projectGrantIndex = useMemo(() => activeGrantIndex(projectGrants), [projectGrants, grantTick]);

  // A deep link followed after unlock replaces `/unlock` with this screen: nothing behind it.
  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)'));
  const onDecide = useCallback((actionId: string, decision: ChatDecision) => void decide(actionId, decision), [decide]);
  const onDecideMany = useCallback((d: { id: string; decision: 'approve' | 'deny' }[]) => void decideMany(d), [decideMany]);
  const onRevoke = useCallback((grantId: string) => void revokeGrant(grantId), [revokeGrant]);
  const onAnswer = useCallback((id: string, body: TTabQuestionAnswerBody) => void answerTabQuestion(id, body), [answerTabQuestion]);
  const onForget = useCallback((decisionId: string) => forgetDecision(decisionId), [forgetDecision]);
  const onSendSuggestion = useCallback((id: string, text: string) => void sendTabSuggestion(id, text), [sendTabSuggestion]);
  const onDismissSuggestion = useCallback((id: string) => void dismissTabSuggestion(id), [dismissTabSuggestion]);
  const timeline = useMemo(() => chatTimeline(messages ?? [], actions ?? [], tabQuestions ?? [], tabSuggestions ?? []), [messages, actions, tabQuestions, tabSuggestions]);
  const pendingKey = (actions ?? [])
    .filter((a) => a.status === 'pending')
    .map((a) => a.id)
    .join(',');
  useEffect(() => setSeparate(false), [pendingKey]);
  // Newest first, for the inverted list that keeps the thread pinned to its end.
  const entries = useMemo(() => (separate ? timeline : groupPendingActions(timeline)).slice().reverse(), [separate, timeline]);

  // Stable across deltas: a message row reads its own streamed text from the store (`MessageRow`),
  // so neither this callback nor `extra` change while an answer streams. The memoised rows re-render
  // only where their own props changed.
  const onShowSeparately = useCallback(() => setSeparate(true), []);
  const renderItem = useCallback(
    ({ item }: { item: ChatEntry }) =>
      item.kind === 'tab_suggestion' ? (
        <TabSuggestionCard
          suggestion={item.suggestion}
          busy={busySuggestionIds.includes(item.suggestion.id)}
          error={suggestionErrors[item.suggestion.id] ?? null}
          onSend={onSendSuggestion}
          onDismiss={onDismissSuggestion}
        />
      ) : item.kind === 'tab_question' ? (
        <TabQuestionCard
          question={item.question}
          busy={answeringQuestionIds.includes(item.question.id)}
          error={questionErrors[item.question.id] ?? null}
          onAnswer={onAnswer}
          loadScreen={loadTabQuestionScreen}
          onForget={onForget}
        />
      ) : item.kind === 'message' ? (
        <MessageRow message={item.message} />
      ) : item.kind === 'action_group' ? (
        <ActionGroupCard actions={item.actions} busy={decidingId !== null} onDecide={onDecideMany} onShowSeparately={onShowSeparately} />
      ) : (
        <ActionCard
          action={item.action}
          busy={decidingId !== null}
          onDecide={onDecide}
          grant={grantIndex.get(item.action.id)}
          projectGrant={projectGrantIndex.get(item.action.id)}
          revoking={revokingId !== null}
          onRevoke={onRevoke}
        />
      ),
    [
      answeringQuestionIds,
      questionErrors,
      busySuggestionIds,
      suggestionErrors,
      decidingId,
      grantIndex,
      projectGrantIndex,
      loadTabQuestionScreen,
      onAnswer,
      onDecide,
      onForget,
      onDecideMany,
      onShowSeparately,
      onDismissSuggestion,
      onRevoke,
      onSendSuggestion,
      revokingId,
    ],
  );
  const extra = useMemo(
    () => ({ decidingId, grantIndex, projectGrantIndex, revokingId, answeringQuestionIds, questionErrors, busySuggestionIds, suggestionErrors }),
    [decidingId, grantIndex, projectGrantIndex, revokingId, answeringQuestionIds, questionErrors, busySuggestionIds, suggestionErrors],
  );

  const title = activeProject ? (projects.find((p) => p.id === activeProject)?.name ?? 'Conversa') : 'Chat geral';
  const shownError = error ?? slot?.error ?? null;

  const confirmReset = () => {
    setConfirmingReset(false);
    setSubagentsOpen(false);
    void reset();
  };

  return (
    <Screen padded={false}>
      {/* `padding` on iOS, `height` on Android (spec §4.2 "Keyboard"): stock behaviour on both, no
          extra native module. The avoiding view compares its frame, relative to its parent, with the
          keyboard's top on screen: the offset is where that parent really starts on screen, measured,
          so the composer lands right on the keyboard. It used to be assumed to be the top safe-area
          inset; wherever the screen really starts elsewhere, the pill floated off the keyboard by the
          difference. */}
      <View ref={bodyRef} testID="conversation-body" className="flex-1" onLayout={measureBody}>
      <KeyboardAvoidingView testID="conversation-keyboard" className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={bodyTop ?? insets.top}>
        {/* The header block — title, host line, error — and the footer block below — grants, composer —
            are siblings of the list, never rows inside it: a line appearing there changes the list's
            frame, not its content, and the inverted list keeps its end pinned through that. */}
        <View>
          <View className="flex-row items-center gap-2 border-b border-app-border px-2 py-2">
            <Button label="Voltar" variant="ghost" onPress={goBack} />
            <AppText variant="title" className="flex-1 text-xl" numberOfLines={1}>
              {title}
            </AppText>
            {/* The subagents panel (spec 2026-09-26 panel §4): the button appears once something is
                running or being cancelled, and — while the sheet is open — stays even after every one
                of them ended, so the sheet it opened always has a way to close it again. */}
            {activeSubagents.length > 0 || subagentsOpen ? <Button label={`Subagentes (${activeSubagents.length})`} variant="ghost" onPress={() => setSubagentsOpen((o) => !o)} /> : null}
            {activeGrantCount > 0 ? <Button label={activeGrantsLabel(activeGrantCount)} variant="ghost" onPress={() => router.push('/chat-grants')} /> : null}
            <Button label="Nova conversa" variant="ghost" onPress={() => setConfirmingReset(true)} />
          </View>
          {/* Only when something stands in the way (offline, no machine, none chosen, an old agent): where a
              ready chat runs, and switching it, live in Ajustes. */}
          {slot?.host && slot.host.kind !== 'ready' ? <HostLine host={slot.host} canChange={activeProject === null} /> : null}
          {shownError ? (
            <View className="px-4 pt-3">
              <Banner tone="danger" text={shownError} />
            </View>
          ) : null}
        </View>
        {entries.length === 0 ? (
          slot && !slot.loaded && !slot.error ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator />
            </View>
          ) : (
            // A tap on the empty thread dismisses the keyboard, as dragging the list does below.
            <Pressable accessible={false} className="flex-1" onPress={Keyboard.dismiss}>
              <EmptyState title="Nenhuma mensagem ainda" hint="Escreva abaixo para começar a conversa." />
            </Pressable>
          )
        ) : (
          <FlatList inverted keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" data={entries} keyExtractor={entryKey} contentContainerClassName="gap-3 px-4 py-4" extraData={extra} renderItem={renderItem} />
        )}
        {/* The footer block, a sibling of the list like the header: its height changes the list's
            frame, not its content (spec 2026-09-26 §4.2 "Keyboard"). */}
        <View>
          <Composer sending={sending} onSend={send} uploadAttachment={uploadAttachment} deleteAttachment={deleteAttachment} attachmentStatuses={attachmentStatuses} />
        </View>
      </KeyboardAvoidingView>
      </View>
      <Sheet open={confirmingReset} onClose={() => setConfirmingReset(false)} title="Começar uma nova conversa?">
        <View className="gap-3">
          <AppText variant="muted">A conversa atual fica arquivada e o chat começa do zero.</AppText>
          <Button label="Começar nova conversa" variant="danger" onPress={confirmReset} />
          <Button label="Cancelar" variant="ghost" onPress={() => setConfirmingReset(false)} />
        </View>
      </Sheet>
      <SubagentsSheet open={subagentsOpen} onClose={() => setSubagentsOpen(false)} subagents={subagents} cancelFailed={cancelFailed} onCancel={onCancelSubagent} now={subagentsNow} />
    </Screen>
  );
}
