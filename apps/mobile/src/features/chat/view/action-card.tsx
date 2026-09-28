import { memo } from 'react';
import { View } from 'react-native';
import { isBoardGrantable, isTabGrantable, isTerminalGrantable } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { untilLabel } from '../model/grant-time';
import type { ChatDecision } from '../viewmodel/createChatStore';
import type { ChatAction, ChatGrant, ChatProjectGrant } from '../model/types';

const STATUS_LABEL: Record<Exclude<ChatAction['status'], 'pending'>, string> = {
  approved: 'autorizada',
  denied: 'recusada',
  expired: 'expirada',
  executed: 'executada',
  failed: 'falhou',
};

type Props = {
  action: ChatAction;
  busy: boolean;
  onDecide(actionId: string, decision: ChatDecision): void;
  /** The tab grant this card created ("Permitir sempre nesta aba"), while it is still in force. */
  grant?: ChatGrant;
  /** The project grant this card created ("Permitir sempre neste projeto"), while it is still in force. */
  projectGrant?: ChatProjectGrant;
  revoking: boolean;
  onRevoke(grantId: string): void;
};

/** A write the concierge proposed: its server-composed summary, and Autorizar (PIN) / Recusar while
 * pending — plus "Permitir sempre nesta aba" (PIN) for a send_input to a tab, or "Permitir sempre
 * neste projeto" (PIN) for one of the four board tools, and the wider "Liberar teclas e shell nesta
 * aba" (a send_input/send_key to a tab) and "Liberar tudo neste projeto" (either kind), each with the
 * PIN and its own proof word — or how it ended ("· aba confiada" /
 * "· quadro confiado" when it ran under a grant), and "Permitido até HH:MM · Revogar" on the card
 * that trusted its tab or its project. Memoised: `onDecide` and `onRevoke` are the store's own
 * (stable) actions. */
export const ActionCard = memo(function ActionCard({ action, busy, onDecide, grant, projectGrant, revoking, onRevoke }: Props) {
  // explicit fields: the contract infers `args` (z.unknown) as optional
  const terminal = isTerminalGrantable({ tool: action.tool, args: action.args, tab_id: action.tab_id });
  return (
    <View className="gap-3 rounded-2xl border border-app-accent bg-app-surface2 p-4">
      <AppText variant="label">Pedido de confirmação</AppText>
      <AppText>{action.summary}</AppText>
      {/* The subagent whose turn proposed this action (spec 2026-09-26 §4), when there is one. */}
      {action.subagent ? <AppText variant="muted">{`Pedido pelo subagente «${action.subagent.description}»`}</AppText> : null}
      {action.status === 'pending' ? (
        <View className="gap-2">
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button label="Autorizar" onPress={() => onDecide(action.id, 'approve')} disabled={busy} />
            </View>
            <View className="flex-1">
              <Button label="Recusar" variant="secondary" onPress={() => onDecide(action.id, 'deny')} disabled={busy} />
            </View>
          </View>
          {/* explicit fields: the contract infers `args` (z.unknown) as optional */}
          {isTabGrantable({ tool: action.tool, args: action.args, tab_id: action.tab_id }) ? (
            <Button label="Permitir sempre nesta aba" variant="secondary" onPress={() => onDecide(action.id, 'approve_tab')} disabled={busy} />
          ) : null}
          {isBoardGrantable({ tool: action.tool }) ? (
            <Button label="Permitir sempre neste projeto" variant="secondary" onPress={() => onDecide(action.id, 'approve_project')} disabled={busy} />
          ) : null}
          {terminal ? (
            <Button label="Liberar teclas e shell nesta aba" variant="secondary" onPress={() => onDecide(action.id, 'approve_tab_terminal')} disabled={busy} />
          ) : null}
          {terminal || isBoardGrantable({ tool: action.tool }) ? (
            <Button label="Liberar tudo neste projeto" variant="secondary" onPress={() => onDecide(action.id, 'approve_project_all')} disabled={busy} />
          ) : null}
        </View>
      ) : (
        <AppText variant="muted">{`${STATUS_LABEL[action.status]}${action.grant_id ? (isBoardGrantable({ tool: action.tool }) ? ' · quadro confiado' : ' · aba confiada') : ''}`}</AppText>
      )}
      {grant ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">{`${grant.tool === 'terminal' ? 'Teclas e shell liberados ' : 'Permitido '}${untilLabel(grant.expires_at)}`}</AppText>
          <Button label="Revogar" variant="ghost" onPress={() => onRevoke(grant.id)} disabled={revoking} />
        </View>
      ) : null}
      {projectGrant ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">{`${projectGrant.scope === 'all' ? 'Tudo liberado neste projeto ' : 'Permitido neste projeto '}${untilLabel(projectGrant.expires_at)}`}</AppText>
          <Button label="Revogar" variant="ghost" onPress={() => onRevoke(projectGrant.id)} disabled={revoking} />
        </View>
      ) : null}
    </View>
  );
});
