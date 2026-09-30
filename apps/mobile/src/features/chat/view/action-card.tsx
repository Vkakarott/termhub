import { memo } from 'react';
import { View } from 'react-native';
import { standingKindLabel } from '@/features/chat-grants/model/labels';
import { isBoardGrantable, isTabGrantable, isTerminalGrantable, STANDING_KIND_LABEL, standingKindOf } from '@/services/api/contract';
import { AppText, Button } from '@/ui';
import { untilLabel } from '../model/grant-time';
import type { ChatDecision } from '../viewmodel/createChatStore';
import type { ChatAction, ChatGrant, ChatProjectGrant, ChatStandingGrant } from '../model/types';

const STATUS_LABEL: Record<Exclude<ChatAction['status'], 'pending'>, string> = {
  approved: 'autorizada',
  denied: 'recusada',
  expired: 'expirada',
  executed: 'executada',
  failed: 'falhou',
};

/** Why a `failed` card went stale rather than failing to run (spec 2026-09-30 §2.3): the gate refused
 * a decision that no longer fits the tab. Read as expired, with the reason — the web's `STALE_REASON`. */
const STALE_REASON: Record<string, string> = {
  TAB_GONE: 'expirou: a aba foi fechada',
  WAITING_PERMISSION: 'expirou: a aba passou a pedir uma permissão',
  PROMPT_CHANGED: 'expirou: a aba está pedindo outra permissão',
};

/** The line an expired or stale card reads, or null for any other card (TER-477). */
export function staleLabel(action: ChatAction): string | null {
  if (action.status === 'expired') return 'expirou sem resposta';
  if (action.status === 'failed') return STALE_REASON[action.error_code ?? ''] ?? null;
  return null;
}

/** Tools whose standing grant trusts the project's tabs themselves (open, close, start an agent). */
const TAB_LIFECYCLE_TOOLS = new Set(['open_tab', 'close_tab', 'start_agent']);

/** What a call run under a grant adds to its status line — the web's `grantedLabel`. */
function grantedLabel(action: ChatAction): string {
  // TER-627: a default allowance of the chat, not a grant the person gave (`default:<kind>:<user>`).
  if (action.grant_id?.startsWith('default:')) return ' · liberado por padrão';
  if (isBoardGrantable({ tool: action.tool })) return ' · quadro confiado';
  if (TAB_LIFECYCLE_TOOLS.has(action.tool)) return ' · liberado no projeto';
  return ' · aba confiada';
}

type Props = {
  action: ChatAction;
  busy: boolean;
  onDecide(actionId: string, decision: ChatDecision): void;
  /** The tab grant this card created ("Permitir sempre nesta aba"), while it is still in force. */
  grant?: ChatGrant;
  /** The project grant this card created ("Permitir sempre neste projeto"), while it is still in force. */
  projectGrant?: ChatProjectGrant;
  /** The standing grant this card created ("Liberar sem prazo"), until it is revoked. */
  standingGrant?: ChatStandingGrant;
  revoking: boolean;
  onRevoke(grantId: string): void;
  /** "Propor de novo" on an expired or stale card (TER-477): asks the concierge for a fresh card. */
  onRepropose?(action: ChatAction): void;
};

/** A write the concierge proposed: its server-composed summary, and Autorizar (PIN) / Recusar while
 * pending — plus "Permitir sempre nesta aba" (PIN) for a send_input to a tab, or "Permitir sempre
 * neste projeto" (PIN) for one of the four board tools, and the wider "Liberar teclas e shell nesta
 * aba" (a send_input/send_key to a tab) and "Liberar tudo neste projeto" (either kind), each with the
 * PIN and its own proof word, and "Liberar sem prazo: <ação> neste projeto" (PIN, TER-386) when the card
 * maps to a standing kind — or how it ended ("· aba confiada" / "· quadro confiado" / "· liberado no
 * projeto" when it ran under a grant), and "Permitido até HH:MM · Revogar" (or "…, sem prazo · Revogar")
 * on the card that created the grant. An expired or stale card says why and offers "Propor de novo"
 * (TER-477), with a muted border: it waits on nobody. Memoised: `onDecide` and `onRevoke` are the store's own
 * (stable) actions. */
export const ActionCard = memo(function ActionCard({ action, busy, onDecide, grant, projectGrant, standingGrant, revoking, onRevoke, onRepropose }: Props) {
  // explicit fields: the contract infers `args` (z.unknown) as optional
  const terminal = isTerminalGrantable({ tool: action.tool, args: action.args, tab_id: action.tab_id });
  const standingKind = standingKindOf({ tool: action.tool, args: action.args, tab_id: action.tab_id, project_id: action.project_id });
  const stale = staleLabel(action);
  return (
    <View testID={`action-card-${action.id}`} className={`gap-3 rounded-2xl border ${stale ? 'border-app-border' : 'border-app-accent'} bg-app-surface2 p-4`}>
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
          {standingKind ? (
            <Button label={`Liberar sem prazo: ${STANDING_KIND_LABEL[standingKind]} neste projeto`} variant="secondary" onPress={() => onDecide(action.id, 'approve_project_always')} disabled={busy} />
          ) : null}
        </View>
      ) : stale ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">
            {stale}
          </AppText>
          {onRepropose ? <Button label="Propor de novo" variant="ghost" onPress={() => onRepropose(action)} /> : null}
        </View>
      ) : (
        <AppText variant="muted">{`${STATUS_LABEL[action.status]}${action.grant_id ? grantedLabel(action) : ''}`}</AppText>
      )}
      {grant ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">{`${grant.tool === 'terminal' ? 'Teclas e shell liberados nesta aba ' : 'Permitido '}${untilLabel(grant.expires_at)}`}</AppText>
          <Button label="Revogar" variant="ghost" onPress={() => onRevoke(grant.id)} disabled={revoking} />
        </View>
      ) : null}
      {projectGrant ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">{`${projectGrant.scope === 'all' ? 'Tudo liberado neste projeto ' : 'Permitido neste projeto '}${untilLabel(projectGrant.expires_at)}`}</AppText>
          <Button label="Revogar" variant="ghost" onPress={() => onRevoke(projectGrant.id)} disabled={revoking} />
        </View>
      ) : null}
      {standingGrant ? (
        <View className="flex-row items-center justify-between gap-2">
          <AppText variant="muted" className="flex-1">{`${standingKindLabel(standingGrant.kind)} liberado neste projeto, sem prazo`}</AppText>
          <Button label="Revogar" variant="ghost" onPress={() => onRevoke(standingGrant.id)} disabled={revoking} />
        </View>
      ) : null}
    </View>
  );
});
