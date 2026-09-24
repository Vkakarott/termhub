import { View } from 'react-native';
import { AppText, Button } from '@/ui';
import type { ChatDecision } from '../viewmodel/createChatStore';
import type { ChatAction } from '../model/types';

const STATUS_LABEL: Record<Exclude<ChatAction['status'], 'pending'>, string> = {
  approved: 'autorizada',
  denied: 'recusada',
  expired: 'expirada',
  executed: 'executada',
  failed: 'falhou',
};

/** A write the concierge proposed: its server-composed summary, and Autorizar (PIN) / Recusar while
 * pending, or how it ended. */
export function ActionCard({ action, busy, onDecide }: { action: ChatAction; busy: boolean; onDecide(decision: ChatDecision): void }) {
  return (
    <View className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
      <AppText variant="label">Pedido de confirmação</AppText>
      <AppText>{action.summary}</AppText>
      {action.status === 'pending' ? (
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button label="Autorizar" onPress={() => onDecide('approve')} disabled={busy} />
          </View>
          <View className="flex-1">
            <Button label="Recusar" variant="secondary" onPress={() => onDecide('deny')} disabled={busy} />
          </View>
        </View>
      ) : (
        <AppText variant="muted">{STATUS_LABEL[action.status]}</AppText>
      )}
    </View>
  );
}
