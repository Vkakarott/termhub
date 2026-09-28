// Verbatim from apps/web/src/components/chat/grant-list-text.ts
import { STANDING_KIND_LABEL, type StandingGrantKind as ChatStandingKind, type TChatGrantListItem as ChatGrantListItem } from '@/services/api/contract';

type ChatGrantState = ChatGrantListItem['state'];

const pad = (n: number) => String(n).padStart(2, '0');

/** The chat header's link to "Permissões do chat": tab grants and project grants together. */
export const activeGrantsLabel = (n: number): string => (n === 1 ? '1 permissão ativa' : `${n} permissões ativas`);

export const grantTabLabel = (g: Pick<ChatGrantListItem, 'tab_name'>): string => (g.tab_name ? `Aba ${g.tab_name}` : 'Aba que não existe mais');

/** How "Liberar sem prazo: <ação> neste projeto" names each standing kind (spec 2026-09-28 TER-386 §6):
 * the web keeps its own copy of the table; the app takes the contract's. */
export { STANDING_KIND_LABEL };

/** The kind's label at the start of a sentence: "Fechar abas paradas". */
export const standingKindLabel = (kind: ChatStandingKind): string => {
  const label = STANDING_KIND_LABEL[kind];
  return label.charAt(0).toUpperCase() + label.slice(1);
};

/** A row's own title: a tab grant names the tab (and the terminal level, if it is one), a project grant
 * names the project (and its "tudo" scope, if it is one), a standing grant names its kind and project —
 * or that the tab or project is gone. */
export const grantTitleLabel = (
  g: Pick<ChatGrantListItem, 'kind' | 'tab_name' | 'project_name'> & Partial<Pick<ChatGrantListItem, 'tool' | 'scope' | 'standing_kind'>>,
): string => {
  if (g.kind === 'standing') return g.project_name && g.standing_kind ? `${standingKindLabel(g.standing_kind)} no projeto ${g.project_name} · sem prazo` : 'Projeto que não existe mais';
  if (g.kind === 'project') return g.project_name ? (g.scope === 'all' ? `Tudo no projeto ${g.project_name}` : `Quadro do projeto ${g.project_name}`) : 'Projeto que não existe mais';
  return `${grantTabLabel(g)}${g.tool === 'terminal' ? ' · teclas e shell' : ''}`;
};

/** Which conversation granted it; a reset conversation says so, and a standing grant whose granting
 * conversation was deleted (it outlives it, `conversation_id` null) says that. */
export function grantOriginLabel(g: Pick<ChatGrantListItem, 'kind' | 'conversation_id' | 'conversation_project_name' | 'conversation_archived'>): string {
  if (g.kind === 'standing' && g.conversation_id === null) return 'Conversa apagada';
  const base = g.conversation_project_name ? `Chat do projeto ${g.conversation_project_name}` : 'Chat geral';
  return g.conversation_archived ? `${base} · conversa encerrada` : base;
}

export const GRANT_STATE_LABEL: Record<ChatGrantState, string> = { active: 'Ativa', expired: 'Expirou', revoked: 'Revogada', ended: 'Encerrada com a conversa' };

export function endedAtLabel(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
