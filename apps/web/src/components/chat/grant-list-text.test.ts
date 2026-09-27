import { expect, it } from 'vitest';
import { activeGrantsLabel, endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTabLabel, grantTitleLabel } from './grant-list-text';

it('counts active grants in pt-BR', () => {
  expect(activeGrantsLabel(1)).toBe('1 permissão ativa');
  expect(activeGrantsLabel(3)).toBe('3 permissões ativas');
});
it('names the tab, the origin and the state', () => {
  expect(grantTabLabel({ tab_name: 'api' })).toBe('Aba api');
  expect(grantTabLabel({ tab_name: null })).toBe('Aba que não existe mais');
  expect(grantOriginLabel({ conversation_project_name: null, conversation_archived: false })).toBe('Chat geral');
  expect(grantOriginLabel({ conversation_project_name: 'termhub', conversation_archived: true })).toBe('Chat do projeto termhub · conversa encerrada');
  expect(GRANT_STATE_LABEL).toEqual({ active: 'Ativa', expired: 'Expirou', revoked: 'Revogada', ended: 'Encerrada com a conversa' });
});
it('formats when it ended as dd/mm/aaaa hh:mm in local time', () => {
  const d = new Date(2026, 8, 5, 7, 3);
  expect(endedAtLabel(d.toISOString())).toBe('05/09/2026 07:03');
});
it('titles a tab row by the tab, and a project row by the project', () => {
  expect(grantTitleLabel({ kind: 'tab', tab_name: 'api', project_name: 'termhub' })).toBe('Aba api');
  expect(grantTitleLabel({ kind: 'project', tab_name: null, project_name: 'App' })).toBe('Quadro do projeto App');
  expect(grantTitleLabel({ kind: 'project', tab_name: null, project_name: null })).toBe('Projeto que não existe mais');
});
