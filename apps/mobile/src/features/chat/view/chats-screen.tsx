import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback } from 'react';
import { FlatList, Pressable, RefreshControl, Text, View } from 'react-native';
import { relativeTime } from '@/features/shared/relative-time';
import { AppText, Banner, Screen } from '@/ui';
import { useChatStore } from '../viewmodel/useChatStore';

type Row = { route: string; name: string; busy: boolean; pending: number; lastMessageAt: string | null };

function ChatRow({ row, onPress }: { row: Row; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={row.name} onPress={onPress} className="flex-row items-center gap-3 border-b border-app-border px-6 py-4">
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
 * answering and how many confirmations wait for the person. */
export function ChatsScreen() {
  const router = useRouter();
  const projects = useChatStore((s) => s.projects);
  const loading = useChatStore((s) => s.loadingProjects);
  const error = useChatStore((s) => s.error);
  const loadProjects = useChatStore((s) => s.loadProjects);

  // On every focus, not only on mount: the tabs stay mounted under a pushed conversation, so a
  // decision or a finished answer there would otherwise leave this list stale.
  useFocusEffect(
    useCallback(() => {
      void loadProjects();
    }, [loadProjects]),
  );

  const rows: Row[] = [
    { route: 'general', name: 'Chat geral', busy: false, pending: 0, lastMessageAt: null },
    ...projects.map((p) => ({ route: p.id, name: p.name, busy: p.busy, pending: p.pending_confirmations, lastMessageAt: p.last_message_at })),
  ];

  return (
    <Screen padded={false}>
      <View className="gap-3 px-6 pb-2 pt-4">
        <AppText variant="title">Chats</AppText>
        {error ? <Banner tone="danger" text={error} /> : null}
      </View>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.route}
        renderItem={({ item }) => <ChatRow row={item} onPress={() => router.push(`/chat/${item.route}` as Href)} />}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => void loadProjects()} />}
      />
    </Screen>
  );
}
