import { memo, useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import type { TTabQuestionAnswerBody } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { answerSummary, statusLabel, suggestionLine, tabLabel } from '../model/tab-question-text';
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

function ChoiceBody({ question, busy, onAnswer, onForget }: Props & { question: Choice }) {
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
  const title = <AppText variant="label">{`${tabLabel(question)} perguntou`}</AppText>;
  if (question.status !== 'open') {
    return (
      <View className="gap-1">
        {title}
        {answerSummary(question).map((line, i) => (
          <AppText key={i}>{line}</AppText>
        ))}
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
          <Button label="Esquecer esta decisão" variant="ghost" disabled={busy} onPress={() => forget(currentHint)} />
        </View>
      ) : null}
      <Button label="Responder" onPress={() => onAnswer(question.id, { answers })} disabled={busy || !complete || suggestedUnseen} />
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
