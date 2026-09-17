export type IntegrationProvider = 'github' | 'linear' | 'jira';
export type KanbanStatus = 'backlog' | 'todo' | 'doing' | 'done';

/** Ticket normalizado vindo de Linear/Jira/GitHub. */
export interface ExternalTicket {
  /** chave estável: "linear:<id>" | "jira:<KEY>" | "github:<owner/repo>#<n>" */
  key: string;
  provider: IntegrationProvider;
  id: string;
  /** identificador humano: EI-123, PROJ-45, #12 */
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  /** estado bruto do provedor */
  state: string;
  /** mapeado para o kanban */
  status: KanbanStatus;
  updatedAt: string;
  /** dados extras do provedor (prioridade, labels, assignee...) */
  meta?: Record<string, unknown>;
}

export interface ConnectionInfo {
  ok: boolean;
  /** quem está autenticado (login/e-mail) */
  account?: string;
  /** opções descobertas (times do Linear, projetos do Jira, ...) para preencher o setup */
  options?: Record<string, { id: string; name: string }[]>;
  error?: string;
}

/** Configuração da fonte de tickets em um projeto (vem do ProjectSetup.tickets). */
export interface TicketSourceConfig {
  provider: IntegrationProvider;
  integration_id: string;
  /** Linear: team key/ID; Jira: project key; GitHub: owner/repo */
  scope: string;
  /** filtro extra: Linear = nomes de estados; Jira = JQL adicional; GitHub = labels */
  filter?: string | null;
  /** incluir tickets concluídos (default: só os abertos + concluídos recentemente) */
  include_done?: boolean;
}

export interface TicketProvider {
  provider: IntegrationProvider;
  /** valida credenciais e devolve opções para o setup */
  testConnection(secret: string, config: Record<string, unknown>): Promise<ConnectionInfo>;
  /** lista tickets do escopo configurado */
  listTickets(secret: string, config: Record<string, unknown>, source: TicketSourceConfig): Promise<ExternalTicket[]>;
  /**
   * Atualiza o estado do ticket no provedor para refletir a coluna do kanban.
   * Só é chamado por ação explícita do usuário. Devolve o novo estado bruto.
   */
  updateStatus(secret: string, config: Record<string, unknown>, ticket: { id: string; identifier: string; scope: string }, status: KanbanStatus): Promise<string>;
}
