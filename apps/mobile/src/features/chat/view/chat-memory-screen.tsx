import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Alert, FlatList, Switch, View } from 'react-native';
import type { TChatDecision, TConciergeNote } from '@/services/api/contract';
import { AppText, Banner, Button, EmptyState, Field, Screen } from '@/ui';
import { useChatMemoryStore } from '../viewmodel/useChatMemoryStore';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

/** One decision's answer, as the list shows it: the picked labels, or the free text (chat decision
 * memory spec 2026-09-26 §4.6 — `answer.text` and `answer.labels` are mutually meaningful, never
 * both at once). Copied from `apps/web/src/pages/ChatMemoryPage.tsx`'s `answerText`. */
function answerText(d: TChatDecision): string {
  return d.answer.text ?? d.answer.labels.join(', ');
}

function DecisionRow({ decision, forgetting, onForget }: { decision: TChatDecision; forgetting: boolean; onForget(): void }) {
  return (
    <View className="gap-1 rounded-xl border border-app-border bg-app-surface2 p-4">
      <AppText className="font-semibold">{decision.question}</AppText>
      <AppText variant="muted">{`→ ${answerText(decision)}`}</AppText>
      <AppText variant="muted" className="text-xs">
        {`${decision.project_name ?? 'sem projeto'} · ${fmtDate(decision.created_at)} · sugerida ${decision.suggested_count}× · aceita ${decision.accepted_count}×`}
      </AppText>
      <Button label="Esquecer" variant="ghost" disabled={forgetting} onPress={onForget} />
    </View>
  );
}

/** "Anotações do concierge" (spec D12/§8): one `record_decision` note, as the list shows it — the
 * mobile twin of `ChatMemoryPage`'s row. */
function NoteRow({ note, forgetting, onForget }: { note: TConciergeNote; forgetting: boolean; onForget(): void }) {
  return (
    <View className="gap-1 rounded-xl border border-app-border bg-app-surface2 p-4">
      <AppText className="font-semibold">{note.question}</AppText>
      <AppText variant="muted">{`→ ${note.decision}`}</AppText>
      <AppText variant="muted" className="text-xs">
        {`${note.reason} · ${note.project_name ?? 'sem projeto'} · ${fmtDate(note.created_at)}`}
      </AppText>
      <Button label="Esquecer" variant="ghost" disabled={forgetting} onPress={onForget} />
    </View>
  );
}

/**
 * "Memória do chat" (chat decision memory spec 2026-09-26 §5.2), route `/chat-memory`, reached from
 * a row in Ajustes: the switch, a search field and the list of remembered decisions, paginated —
 * the mobile twin of the web's `ChatMemoryPage`. "Esquecer" confirms with a native `Alert.alert`
 * (the web asks `window.confirm`); no PIN either way, consistent with TER-56's cards.
 */
export function ChatMemoryScreen() {
  const router = useRouter();
  const memory = useChatMemoryStore((s) => s.memory);
  const decisions = useChatMemoryStore((s) => s.decisions);
  const cursor = useChatMemoryStore((s) => s.cursor);
  const q = useChatMemoryStore((s) => s.q);
  const loadingMore = useChatMemoryStore((s) => s.loadingMore);
  const switching = useChatMemoryStore((s) => s.switching);
  const forgettingId = useChatMemoryStore((s) => s.forgettingId);
  const error = useChatMemoryStore((s) => s.error);
  const load = useChatMemoryStore((s) => s.load);
  const search = useChatMemoryStore((s) => s.search);
  const loadMore = useChatMemoryStore((s) => s.loadMore);
  const toggle = useChatMemoryStore((s) => s.toggle);
  const setAutodecide = useChatMemoryStore((s) => s.setAutodecide);
  const forget = useChatMemoryStore((s) => s.forget);
  const cancel = useChatMemoryStore((s) => s.cancel);
  const notes = useChatMemoryStore((s) => s.notes);
  const notesCursor = useChatMemoryStore((s) => s.notesCursor);
  const loadingMoreNotes = useChatMemoryStore((s) => s.loadingMoreNotes);
  const forgettingNoteId = useChatMemoryStore((s) => s.forgettingNoteId);
  const notesError = useChatMemoryStore((s) => s.notesError);
  const loadNotes = useChatMemoryStore((s) => s.loadNotes);
  const loadMoreNotes = useChatMemoryStore((s) => s.loadMoreNotes);
  const forgetNote = useChatMemoryStore((s) => s.forgetNote);

  useEffect(() => {
    void load();
    // "Anotações do concierge" reads on its own, independent of the search box above — same as the
    // web page's own effect for `api.chatNotes()`.
    void loadNotes();
    // The store is a singleton that outlives this screen: leaving before a debounced search fires,
    // or while one is already in flight, must not let it land later and clobber the next visit's
    // own fresh `load()` — `cancel()` (createChatMemoryStore.ts) guards exactly that.
    return () => cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/(tabs)'));

  const confirmForget = (d: TChatDecision) => {
    Alert.alert('Esquecer esta decisão?', `«${d.question}»`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Esquecer', style: 'destructive', onPress: () => void forget(d.id) },
    ]);
  };

  const confirmForgetNote = (n: TConciergeNote) => {
    Alert.alert('Esquecer esta anotação?', `«${n.question}»`, [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Esquecer', style: 'destructive', onPress: () => void forgetNote(n.id) },
    ]);
  };

  return (
    <Screen padded={false}>
      <View className="flex-row items-center gap-2 border-b border-app-border px-2 py-2">
        <Button label="Voltar" variant="ghost" onPress={goBack} />
        <AppText variant="title" className="flex-1 text-xl">
          Memória do chat
        </AppText>
      </View>
      <View className="gap-3 px-6 pb-2 pt-4">
        <AppText variant="muted">
          O que o concierge lembra das suas respostas anteriores, para sugerir a mesma resposta quando uma aba perguntar de novo.
        </AppText>
        {memory?.available === false ? (
          <AppText variant="muted">Sugestões indisponíveis neste servidor</AppText>
        ) : memory ? (
          <>
            <View className="flex-row items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface2 p-3">
              <AppText className="flex-1">Sugerir respostas com base nas minhas decisões</AppText>
              <Switch accessibilityLabel="Sugerir respostas com base nas minhas decisões" value={memory.enabled} disabled={switching} onValueChange={() => void toggle()} />
            </View>
            <View className="gap-1 rounded-xl border border-app-border bg-app-surface2 p-3">
              <View className="flex-row items-center justify-between gap-3">
                <AppText className="flex-1">Responder sozinho quando houver precedente</AppText>
                <Switch accessibilityLabel="Responder sozinho quando houver precedente" value={memory.autodecide} onValueChange={(v) => void setAutodecide(v)} />
              </View>
              <AppText variant="muted" className="text-xs">
                Quando a resposta repetir uma decisão sua recente, o concierge espera 60 segundos antes de responder por você, dando tempo de cancelar.
              </AppText>
            </View>
          </>
        ) : null}
        <Field label="Buscar" value={q} onChangeText={search} placeholder="pergunta, resposta ou projeto" testID="chat-memory-search" />
        {error ? <Banner tone="danger" text={error} /> : null}
      </View>
      {/* One scrolling region for both lists (design mirrors `ChatMemoryPage`'s single page): the
       * notes section always rides in the decisions `FlatList`'s footer, so it shows up whichever
       * state the decisions list itself is in (loading, empty or a page of rows). */}
      <FlatList
        data={decisions ?? []}
        keyExtractor={(d) => d.id}
        contentContainerClassName="gap-3 px-6 pb-6"
        renderItem={({ item }) => <DecisionRow decision={item} forgetting={forgettingId === item.id} onForget={() => confirmForget(item)} />}
        ListEmptyComponent={
          decisions === null ? (
            <View className="items-center justify-center py-6">
              <AppText variant="muted">Carregando…</AppText>
            </View>
          ) : (
            <EmptyState title="Nenhuma decisão lembrada" hint="Suas respostas às perguntas das abas aparecem aqui." />
          )
        }
        ListFooterComponent={
          <View className="gap-3">
            {cursor ? <Button label={loadingMore ? 'Carregando…' : 'Carregar mais'} variant="ghost" disabled={loadingMore} onPress={() => void loadMore()} /> : null}
            <View className="gap-3 pt-6">
              <AppText variant="title" className="text-base">
                Anotações do concierge
              </AppText>
              <AppText variant="muted">Decisões que o concierge registrou por conta própria, com o motivo que deu para cada uma.</AppText>
              {notesError ? <Banner tone="danger" text={notesError} /> : null}
              {notes === null ? (
                <AppText variant="muted">Carregando…</AppText>
              ) : notes.length === 0 ? (
                <AppText variant="muted">Nenhuma anotação ainda.</AppText>
              ) : (
                <View className="gap-3">
                  {notes.map((n) => (
                    <NoteRow key={n.id} note={n} forgetting={forgettingNoteId === n.id} onForget={() => confirmForgetNote(n)} />
                  ))}
                </View>
              )}
              {notesCursor ? (
                <Button label={loadingMoreNotes ? 'Carregando…' : 'Carregar mais anotações'} variant="ghost" disabled={loadingMoreNotes} onPress={() => void loadMoreNotes()} />
              ) : null}
            </View>
          </View>
        }
      />
    </Screen>
  );
}
