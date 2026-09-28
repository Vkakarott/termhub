import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { relativeTime } from '@/features/shared/relative-time';
import { AppText, Banner, EmptyState, Screen, SPLIT_LIST_WIDTH, useWideLayout } from '@/ui';
import { useChatStore } from '../viewmodel/useChatStore';
import { ConversationView } from './conversation-screen';

/** How long the split's list waits after the last socket event of a burst before re-reading the
 * projects: one request per burst of cards, decisions and messages, not one per event. */
const LIVE_LIST_DEBOUNCE_MS = 1000;

type Row = { route: string; name: string; busy: boolean; pending: number; lastMessageAt: string | null };

function ChatRow({ row, selected, onPress }: { row: Row; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.name}
      accessibilityState={{ selected }}
      onPress={onPress}
      className={`flex-row items-center gap-3 border-b border-app-border px-6 py-4 ${selected ? 'bg-app-surface' : ''}`}
    >
      <View className="flex-1 gap-0.5">
        <AppText className="font-semibold">{row.name}</AppText>
        {row.busy ? <AppText variant="muted" className="text-app-accent">respondendo…</AppText> : null}
      </View>
      {row.pending > 0 ? (
        <View
          accessibilityLabel={`${row.pending} ${row.pending === 1 ? 'confirmação pendente' : 'confirmações pendentes'}`}
          className="min-w-6 items-center rounded-full bg-app-accent px-2 py-0.5"
        >
          <Text className="text-xs font-semibold text-white">{row.pending}</Text>
        </View>
      ) : null}
      {row.lastMessageAt ? <AppText variant="muted">{relativeTime(row.lastMessageAt, Date.now())}</AppText> : null}
    </Pressable>
  );
}

/** Chats (spec §11.2): the account-wide chat, then one per project, each saying whether it is
 * answering and how many confirmations wait for the person. From `WIDE_MIN_WIDTH` (spec 2026-09-28
 * iPad §2.3) the list and the chosen conversation sit side by side instead of pushing a screen. */
export function ChatsScreen() {
  const router = useRouter();
  const projects = useChatStore((s) => s.projects);
  const loading = useChatStore((s) => s.loadingProjects);
  const error = useChatStore((s) => s.error);
  const loadProjects = useChatStore((s) => s.loadProjects);
  const wide = useWideLayout();
  const openByRoute = useChatStore((s) => s.openByRoute);
  const subscribeEvents = useChatStore((s) => s.subscribeEvents);
  /** The chat in the split's right pane (spec 2026-09-28 iPad §2.3). Kept while the window is
   * compact, so widening it again brings the same chat back. */
  const [selected, setSelected] = useState<string | null>(null);
  // Read by the focus effect below without being among its deps: selecting a row already opens it
  // (it mounts `ConversationView`, whose own effect calls `openByRoute`), so the focus callback must
  // not change identity — and re-run — on every selection or width change, or it would fire a
  // redundant `openByRoute`/`loadProjects` on each tap and each rotation across the breakpoint.
  const paneRef = useRef({ wide, selected });
  paneRef.current = { wide, selected };

  // On every focus, not only on mount: the tabs stay mounted under a pushed conversation, so a
  // decision or a finished answer there would otherwise leave this list stale. The split's pane is
  // re-opened too: a pushed conversation (a deep link, a notification) made itself the store's
  // active one, and the pane shows the active one — read from the ref, so this only happens on a
  // real focus, not on every render that changes `wide`/`selected`.
  useFocusEffect(
    useCallback(() => {
      void loadProjects();
      const { wide, selected } = paneRef.current;
      if (wide && selected) void openByRoute(selected);
    }, [loadProjects, openByRoute]),
  );

  // In the split the tab never loses focus while the person works in the pane, so the focus refresh
  // alone would leave "respondendo…", the pending badges and the other projects' activity stale next
  // to the thread (spec 2026-09-28 iPad §2.3). Every socket event but the streamed deltas (the noisy
  // ones, and they change nothing the list shows) schedules a quiet re-read: a `decision` after an
  // approval in the pane, a `confirmation` or `message` anywhere. Quiet, so the list neither spins
  // nor wipes the pane's banner. The server publishes a `decision` for every decided card, so this
  // also covers decisions taken in the pane without hooking `decide`.
  useEffect(() => {
    if (!wide) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeEvents((e) => {
      if (e.type === 'delta') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void loadProjects({ quiet: true });
      }, LIVE_LIST_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [wide, subscribeEvents, loadProjects]);

  const open = (route: string) => (wide ? setSelected(route) : router.push(`/chat/${route}` as Href));

  const rows: Row[] = [
    { route: 'general', name: 'Chat geral', busy: false, pending: 0, lastMessageAt: null },
    ...projects.map((p) => ({ route: p.id, name: p.name, busy: p.busy, pending: p.pending_confirmations, lastMessageAt: p.last_message_at })),
  ];

  const list = (
    <>
      <View className="gap-3 px-6 pb-2 pt-4">
        <AppText variant="title">Chats</AppText>
        {/* The store has one `error`: with a chat in the pane, the pane's banner already shows it. */}
        {error && !(wide && selected) ? <Banner tone="danger" text={error} /> : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.route}
        extraData={wide ? selected : null}
        renderItem={({ item }) => <ChatRow row={item} selected={wide && item.route === selected} onPress={() => open(item.route)} />}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadProjects()} />}
      />
    </>
  );

  if (!wide) return <Screen padded={false}>{list}</Screen>;
  return (
    <Screen padded={false} width="full">
      <View className="flex-1 flex-row">
        <View testID="chats-list-pane" style={{ width: SPLIT_LIST_WIDTH }} className="border-r border-app-border">
          {list}
        </View>
        <View testID="chats-detail-pane" className="flex-1">
          {selected ? <ConversationView key={selected} routeId={selected} embedded /> : <EmptyState title="Escolha uma conversa" hint="Selecione um chat na lista ao lado." />}
        </View>
      </View>
    </Screen>
  );
}
