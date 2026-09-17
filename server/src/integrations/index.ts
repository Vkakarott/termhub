import type { IntegrationProvider, TicketProvider } from './types.js';
import { github } from './github.js';
import { linear } from './linear.js';
import { jiraProvider } from './jira.js';

export const providers: Record<IntegrationProvider, TicketProvider> = {
  github,
  linear,
  jira: jiraProvider,
};

export function getProvider(name: string): TicketProvider {
  const p = providers[name as IntegrationProvider];
  if (!p) throw new Error(`Provedor desconhecido: ${name}`);
  return p;
}

export * from './types.js';
