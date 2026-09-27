import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { untilLabel } from '@/features/chat/model/grant-time';
import type { TChatGrantListItem } from '@/services/api/contract';
import { AppText, Banner, Button, Screen } from '@/ui';
import { endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTitleLabel } from '../model/labels';
import { useChatGrantsStore } from '../viewmodel/useChatGrantsStore';

// A tab row also names its project (a tab grant is always inside one); a project row's title
// already names the project, so nothing is appended there — mirrors the web's own `title`.
const title = (g: TChatGrantListItem) => `${grantTitleLabel(g)}${g.kind === 'tab' && g.project_name ? ` · ${g.project_name}` : ''}`;

/** "Permissões do chat" (design spec 2026-09-26 §7, spec 2026-09-26 §5): the phone's copy of the
 * web list — tab and project grants together. Revogar needs no PIN. */
export function ChatGrantsScreen() {
  const router = useRouter();
  const { active, history, next, loadingMore, revokingId, error, load, loadMore, revoke } = useChatGrantsStore();

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Screen scroll>
      <View className="gap-6 pb-10">
        <View className="flex-row items-center gap-2">
          <Button label="Voltar" variant="ghost" onPress={() => router.back()} />
          <AppText variant="title" className="flex-1">
            Permissões do chat
          </AppText>
        </View>
        <AppText variant="muted">O que o chat pode fazer sem pedir confirmação. Cada permissão vale para uma conversa, por até 24 horas.</AppText>
        {error ? <Banner tone="danger" text={error} /> : null}
        {active === null || history === null ? (
          error ? <Button label="Tentar de novo" variant="secondary" onPress={() => void load()} /> : <ActivityIndicator />
        ) : (
          <>
            <View className="gap-2">
              <AppText variant="label">Ativas</AppText>
              {active.length === 0 ? (
                <AppText variant="muted">Nenhuma permissão ativa agora.</AppText>
              ) : (
                active.map((g) => (
                  <View key={g.id} className="flex-row items-center justify-between gap-2 rounded-xl border border-app-border bg-app-surface2 px-3 py-2">
                    <View className="flex-1">
                      <AppText>{title(g)}</AppText>
                      <AppText variant="muted">{`${grantOriginLabel(g)} · ${untilLabel(g.expires_at)}`}</AppText>
                    </View>
                    <Button label="Revogar" variant="ghost" onPress={() => void revoke(g.id)} disabled={revokingId === g.id} />
                  </View>
                ))
              )}
            </View>
            <View className="gap-2">
              <AppText variant="label">Histórico</AppText>
              {history.length === 0 ? (
                <AppText variant="muted">Nada no histórico ainda.</AppText>
              ) : (
                history.map((g) => (
                  <View key={g.id} className="rounded-xl border border-app-border px-3 py-2">
                    <AppText>{title(g)}</AppText>
                    <AppText variant="muted">{`${grantOriginLabel(g)} · ${GRANT_STATE_LABEL[g.state]}${g.ended_at ? ` em ${endedAtLabel(g.ended_at)}` : ''}`}</AppText>
                  </View>
                ))
              )}
              {next ? <Button label="Carregar mais" variant="secondary" onPress={() => void loadMore()} disabled={loadingMore} /> : null}
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}
