import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { relativeTime } from '@/features/shared/relative-time';
import { AppText, Banner, EmptyState, Screen, SPLIT_LIST_WIDTH, useWideLayout } from '@/ui';
import { useChatStore } from '../viewmodel/useChatStore';
import { ConversationView } from './conversation-screen';

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
  /** The chat in the split's right pane (spec 2026-09-28 iPad §2.3). Kept while the window is
   * compact, so widening it again brings the same chat back. */
  const [selected, setSelected] = useState<string | null>(null);

  // On every focus, not only on mount: the tabs stay mounted under a pushed conversation, so a
  // decision or a finished answer there would otherwise leave this list stale. The split's pane is
  // re-opened too: a pushed conversation (a deep link, a notification) made itself the store's
  // active one, and the pane shows the active one.
  useFocusEffect(
    useCallback(() => {
      void loadProjects();
      if (wide && selected) void openByRoute(selected);
    }, [loadProjects, openByRoute, wide, selected]),
  );

  const open = (route: string) => (wide ? setSelected(route) : router.push(`/chat/${route}` as Href));

  const rows: Row[] = [
    { route: 'general', name: 'Chat geral', busy: false, pending: 0, lastMessageAt: null },
    ...projects.map((p) => ({ route: p.id, name: p.name, busy: p.busy, pending: p.pending_confirmations, lastMessageAt: p.last_message_at })),
  ];

  const list = (
    <>
      <View className="gap-3 px-6 pb-2 pt-4">
        <AppText variant="title">Chats</AppText>
        {error ? <Banner tone="danger" text={error} /> : null}
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
