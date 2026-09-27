import { memo, useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import type { TTabQuestionAnswerBody } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { answerSummary, autoAnswerFailureText, autoAnswerSeconds, choiceAnswerLabel, formatCountdown, statusLabel, suggestionLine, suggestionSourceSentence, tabLabel } from '../model/tab-question-text';
import type { TabQuestion, TabQuestionSuggestionItem } from '../model/types';

type Props = {
  question: TabQuestion;
  /** This card's answer is in flight. */
  busy: boolean;
  /** Why this card's last answer did not go through (pt-BR). */
  error?: string | null;
  onAnswer(questionId: string, body: TTabQuestionAnswerBody): void;
  loadScreen(questionId: string): Promise<string | null>;
  /** "Esquecer esta decisão" on a suggestion line (chat decision memory spec 2026-09-26 §5.1):
   *  forgets the past decision it came from, then the card clears that question's pre-selection
   *  regardless of whether the call succeeds — the server answers 204 even for a decision already
   *  gone. Omitted on a permission card, which never carries a suggestion. */
  onForget?(decisionId: string): Promise<void>;
  /** "Cancelar" on a countdown (concierge memory spec 2026-09-26 §6): like `onAnswer`, fire-and-forget —
   *  the store calls the API, updates this question from the response and surfaces a failure through
   *  `error` (409 `NOT_SCHEDULED` — the countdown already sent — gets its own sentence). Omitted on a
   *  permission card, which never carries a countdown. */
  onCancelAutoAnswer?(questionId: string): void;
};
type Choice = Extract<TabQuestion, { kind: 'choice' }>;
type Permission = Extract<TabQuestion, { kind: 'permission' }>;

const INPUT = 'rounded-xl border border-app-border bg-app-surface px-4 py-3 text-base text-app-text placeholder:text-app-muted';

/** A question an agent in a tab asked (spec 2026-09-25 §6.3), the web card's twin: options with the
 * recommended one marked, "Outra resposta", or Permitir / Negar / Negar e dizer… — no PIN. Memoised:
 * `onAnswer` and `loadScreen` are the store's own (stable) actions. */
export const TabQuestionCard = memo(function TabQuestionCard(props: Props) {
  const { question } = props;
  return (
    // The testID disambiguates this card's own controls (e.g. "Enviar" on a permission's deny-text
    // form) from the composer's own button of the same accessible name, both on screen at once.
    <View testID={`tab-question-${question.id}`} className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
      {question.kind === 'choice' ? <ChoiceBody {...props} question={question} /> : <PermissionBody {...props} question={question} />}
      {question.status !== 'open' ? <AppText variant="muted">{statusLabel(question)}</AppText> : null}
      {props.error ? <AppText className="text-app-danger">{props.error}</AppText> : null}
    </View>
  );
});

function ChoiceBody({ question, busy, onAnswer, onForget, onCancelAutoAnswer }: Props & { question: Choice }) {
  const items = question.payload.questions;
  const [current, setCurrent] = useState(0);
  // Pre-selected from a similar past decision (chat decision memory spec 2026-09-26 §4.2/§5.1): only
  // present while the card is `open`, and only for the questions that matched. `hint` shrinks as
  // each is forgotten.
  const [hint, setHint] = useState(() => question.suggestion?.items ?? []);
  const [selected, setSelected] = useState<number[][]>(() => items.map((_, i) => hint.find((s) => s.question_index === i)?.selected ?? []));
  const [texts, setTexts] = useState<string[]>(() => items.map((_, i) => hint.find((s) => s.question_index === i)?.text ?? ''));
  // Which questions the person has looked at (the first one is shown at once). A pre-selected answer on
  // a tab never opened must not go out with "Responder", so it waits until every suggested one was seen.
  const [viewed, setViewed] = useState<boolean[]>(() => items.map((_, i) => i === 0));
  /** Automatic answer countdown (concierge memory spec 2026-09-26 §6/§8): unlike `hint` above, this
   *  one *does* track `question.auto_answer` on every render — the store owns the cancel call and
   *  hands this card the updated question back, so the countdown/cancelled/sent/failed state always
   *  follows the current prop (a socket event updates it exactly the same way). */
  const auto = question.auto_answer ?? null;
  const [seconds, setSeconds] = useState(() => (auto?.status === 'scheduled' ? autoAnswerSeconds(auto.due_at) : 0));
  const [forgettingPrecedent, setForgettingPrecedent] = useState(false);
  useEffect(() => {
    if (auto?.status !== 'scheduled') return;
    const dueAt = auto.due_at;
    const tick = () => setSeconds(autoAnswerSeconds(dueAt));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [auto?.status, auto?.status === 'scheduled' ? auto.due_at : null]);
  // "Cancelar" resolved (or a socket event landed): the proposed answer becomes this question's own
  // pre-selection, now editable — regardless of whether a matching `suggestion` item also exists.
  useEffect(() => {
    if (auto?.status !== 'cancelled') return;
    const a = auto.answer;
    setSelected(items.map((_, i) => a.answers[i]?.selected ?? []));
    setTexts(items.map((_, i) => a.answers[i]?.text ?? ''));
    setViewed(items.map(() => true));
    // Only the transition into `cancelled` re-seeds the pre-selection — once there, the person's own
    // edits (toggling an option, forgetting a suggestion) must not be overwritten by this effect again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto?.status]);
  const title = <AppText variant="label">{`${tabLabel(question)} perguntou`}</AppText>;
  if (question.status !== 'open') {
    // The countdown is over, but a `failed` one is never shown on a closed card (controller ruling): it
    // only ever explains why *this still-open card* has not answered itself; a `sent` one is the
    // successful automatic answer below (`answered_via: 'auto'`).
    const autoAnswered = question.answered_via === 'auto' && question.auto_answer;
    const forgetPrecedent = async () => {
      if (!question.auto_answer) return;
      setForgettingPrecedent(true);
      try {
        await Promise.allSettled(question.auto_answer.sources.filter((s) => s.kind === 'decision').map((s) => onForget?.(s.id)));
      } finally {
        setForgettingPrecedent(false);
      }
    };
    return (
      <View className="gap-1">
        {title}
        {answerSummary(question).map((line, i) => (
          <AppText key={i}>{line}</AppText>
        ))}
        {autoAnswered ? (
          <View className="gap-1">
            <AppText variant="muted">{`Respondida automaticamente: «${choiceAnswerLabel(question.payload, question.auto_answer!.answer)}» — motivo ${question.auto_answer!.reason}`}</AppText>
            <Button label="Esquecer o precedente" variant="ghost" disabled={forgettingPrecedent} onPress={() => void forgetPrecedent()} />
          </View>
        ) : null}
      </View>
    );
  }
  // A countdown still `scheduled` past its own clock, or `sent` on a card still open (the send is in
  // flight): no interactive options, just the countdown (or "Enviando…") and, while there is still
  // time, "Cancelar" / "Responder agora" (concierge memory spec 2026-09-26 §6/§8).
  const sending = auto?.status === 'sent' || (auto?.status === 'scheduled' && seconds <= 0);
  const counting = auto?.status === 'scheduled' && !sending;
  if (counting || sending) {
    let line = `Resposta automática em ${formatCountdown(seconds)} — «${choiceAnswerLabel(question.payload, auto!.answer)}». Motivo: ${auto!.reason}`;
    if (auto!.by === 'memory') {
      const decisionIds = new Set(auto!.sources.filter((s) => s.kind === 'decision').map((s) => s.id));
      const idx = items.findIndex((_, i) => hint.some((h) => h.question_index === i && decisionIds.has(h.decision_id)));
      const backing = idx === -1 ? undefined : hint.find((h) => h.question_index === idx);
      if (backing) line += ` Fonte: ${suggestionSourceSentence(items[idx]!, backing)}`;
    }
    return (
      <View className="gap-2">
        {title}
        {sending ? (
          <AppText variant="muted">Enviando…</AppText>
        ) : (
          <View className="gap-2">
            <AppText>{line}</AppText>
            <View className="flex-row gap-2">
              <View className="flex-1">
                <Button label="Cancelar" variant="secondary" disabled={busy} onPress={() => onCancelAutoAnswer?.(question.id)} />
              </View>
              <View className="flex-1">
                <Button label="Responder agora" disabled={busy} onPress={() => onAnswer(question.id, auto!.answer)} />
              </View>
            </View>
          </View>
        )}
      </View>
    );
  }
  const item = items[current]!;
  const typing = texts[current]!.trim() !== '';
  const answers = items.map((_, i) => (texts[i]!.trim() ? { selected: [], text: texts[i]!.trim() } : { selected: [...selected[i]!].sort((a, b) => a - b) }));
  const complete = answers.every((a) => 'text' in a || a.selected.length > 0);
  const suggestedUnseen = hint.some((h) => !viewed[h.question_index]);
  const show = (i: number) => {
    setCurrent(i);
    setViewed((prev) => prev.map((v, j) => v || j === i));
  };
  const toggle = (option: number) =>
    setSelected((prev) => prev.map((s, j) => (j !== current ? s : item.multi_select ? (s.includes(option) ? s.filter((x) => x !== option) : [...s, option]) : [option])));
  const currentHint = hint.find((s) => s.question_index === current);
  const forget = (h: TabQuestionSuggestionItem) => {
    const clear = () => {
      setHint((prev) => prev.filter((s) => s !== h));
      setSelected((prev) => prev.map((s, j) => (j === h.question_index ? [] : s)));
      setTexts((prev) => prev.map((t, j) => (j === h.question_index ? '' : t)));
    };
    // An empty id (a concierge suggestion that cited no decision): forgetting only clears the pre-selection.
    const result = h.decision_id ? onForget?.(h.decision_id) : undefined;
    if (result) void result.then(clear, clear);
    else clear();
  };
  return (
    <View className="gap-2">
      {title}
      {items.length > 1 ? (
        <View accessibilityRole="tablist" className="flex-row flex-wrap gap-2">
          {items.map((it, i) => {
            const label = `${it.header || `Pergunta ${i + 1}`}${hint.some((h) => h.question_index === i) ? ' · sugerida' : ''}`;
            const selectedTab = i === current;
            return (
              <Pressable
                key={i}
                accessibilityRole="tab"
                accessibilityLabel={label}
                accessibilityState={{ selected: selectedTab }}
                onPress={() => show(i)}
                className={`rounded-xl px-4 py-3 ${selectedTab ? 'bg-app-accent' : 'border border-app-border bg-app-surface2'}`}
              >
                <AppText className={`font-semibold ${selectedTab ? 'text-white' : 'text-app-text'}`}>{label}</AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      <AppText>{item.question}</AppText>
      {item.options.map((o, oi) => {
        const checked = selected[current]!.includes(oi);
        return (
          <Pressable
            key={oi}
            accessibilityRole={item.multi_select ? 'checkbox' : 'radio'}
            accessibilityLabel={o.recommended ? `${o.label}, recomendada` : o.label}
            accessibilityHint={o.description || undefined}
            accessibilityState={{ checked, disabled: busy || typing }}
            disabled={busy || typing}
            onPress={() => toggle(oi)}
            className={`gap-1 rounded-xl border p-3 ${checked ? 'border-app-accent' : 'border-app-border'}`}
          >
            <AppText>{`${checked ? '●' : '○'} ${o.label}`}</AppText>
            {o.recommended ? <AppText variant="muted">Recomendada</AppText> : null}
            {o.description ? <AppText variant="muted">{o.description}</AppText> : null}
          </Pressable>
        );
      })}
      <TextInput
        accessibilityLabel="Outra resposta"
        placeholder="Outra resposta"
        value={texts[current]}
        maxLength={2000}
        editable={!busy}
        onChangeText={(t) => setTexts((prev) => prev.map((x, j) => (j === current ? t : x)))}
        className={INPUT}
      />
      {currentHint ? (
        <View className="gap-1">
          <AppText variant="muted">{suggestionLine(item, currentHint)}</AppText>
          {/* A concierge suggestion that cited no decision (`decision_id: ""`) has nothing to forget. */}
          {!(currentHint.by === 'concierge' && !currentHint.decision_id) ? (
            <Button label="Esquecer esta decisão" variant="ghost" disabled={busy} onPress={() => forget(currentHint)} />
          ) : null}
        </View>
      ) : null}
      <Button label="Responder" onPress={() => onAnswer(question.id, { answers })} disabled={busy || !complete || suggestedUnseen} />
      {auto?.status === 'failed' ? <AppText className="text-app-danger">{autoAnswerFailureText(auto.error_code)}</AppText> : null}
    </View>
  );
}

function PermissionBody({ question, busy, onAnswer, loadScreen }: Props & { question: Permission }) {
  const open = question.status === 'open';
  const [excerpt, setExcerpt] = useState<string | null>(null);
  // Expanded by default: the tool name alone does not say what is about to run.
  const [showing, setShowing] = useState(true);
  const [denying, setDenying] = useState(false);
  const [text, setText] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void loadScreen(question.id).then((t) => {
      if (alive) setExcerpt(t);
    });
    return () => {
      alive = false;
    };
  }, [open, question.id, loadScreen]);
  return (
    <View className="gap-2">
      <AppText>{`${tabLabel(question)} pede permissão para usar «${question.payload.tool_name}»`}</AppText>
      {open && excerpt !== null ? <Button label="Tela da aba" variant="ghost" onPress={() => setShowing((v) => !v)} /> : null}
      {open && showing && excerpt !== null ? <AppText className="font-mono text-xs">{excerpt}</AppText> : null}
      {open ? (
        <View className="gap-2">
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label="Permitir" onPress={() => onAnswer(question.id, { allow: true })} disabled={busy} />
            </View>
            <View className="flex-1">
              <Button label="Negar" variant="danger" onPress={() => onAnswer(question.id, { allow: false })} disabled={busy} />
            </View>
          </View>
          <Button label="Negar e dizer…" variant="secondary" onPress={() => setDenying(true)} disabled={busy} />
          {denying ? (
            <View className="gap-2">
              <TextInput accessibilityLabel="O que dizer à aba" value={text} maxLength={2000} editable={!busy} onChangeText={setText} className={INPUT} />
              <Button label="Enviar" variant="danger" onPress={() => onAnswer(question.id, { allow: false, text: text.trim() })} disabled={busy || !text.trim()} />
            </View>
          ) : null}
        </View>
      ) : (
        answerSummary(question).map((line, i) => <AppText key={i}>{line}</AppText>)
      )}
    </View>
  );
}
