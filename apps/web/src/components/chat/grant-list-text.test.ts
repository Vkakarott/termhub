import { expect, it } from 'vitest';
import { activeGrantsLabel, endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTabLabel, grantTitleLabel, STANDING_KIND_LABEL, standingKindLabel } from './grant-list-text';

it('counts active grants in pt-BR', () => {
  expect(activeGrantsLabel(1)).toBe('1 permissão ativa');
  expect(activeGrantsLabel(3)).toBe('3 permissões ativas');
});
it('names the tab, the origin and the state', () => {
  expect(grantTabLabel({ tab_name: 'api' })).toBe('Aba api');
  expect(grantTabLabel({ tab_name: null })).toBe('Aba que não existe mais');
  expect(grantOriginLabel({ kind: 'tab', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false })).toBe('Chat geral');
  expect(grantOriginLabel({ kind: 'project', conversation_id: 'c1', conversation_project_name: 'termhub', conversation_archived: true })).toBe('Chat do projeto termhub · conversa encerrada');
  expect(grantOriginLabel({ kind: 'standing', conversation_id: 'c1', conversation_project_name: null, conversation_archived: false })).toBe('Chat geral');
  expect(grantOriginLabel({ kind: 'standing', conversation_id: null, conversation_project_name: null, conversation_archived: false })).toBe('Conversa apagada');
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
it('names the terminal level on a tab row, and the "tudo" scope on a project row', () => {
  expect(grantTitleLabel({ kind: 'tab', tab_name: 'api', tool: 'terminal' })).toBe('Aba api · teclas e shell');
  expect(grantTitleLabel({ kind: 'project', project_name: 'X', scope: 'all' })).toBe('Tudo no projeto X');
  expect(grantTitleLabel({ kind: 'project', project_name: 'X', scope: 'board' })).toBe('Quadro do projeto X');
});
it('names every standing kind, lower-case and capitalised', () => {
  expect(STANDING_KIND_LABEL).toEqual({ open_tab: 'abrir abas', close_tab: 'fechar abas paradas', start_agent: 'iniciar agentes', board: 'mexer no quadro', terminal: 'teclas e texto nas abas' });
  expect(standingKindLabel('close_tab')).toBe('Fechar abas paradas');
  expect(standingKindLabel('terminal')).toBe('Teclas e texto nas abas');
});
it('titles a standing row by its kind and project, or says the project is gone', () => {
  expect(grantTitleLabel({ kind: 'standing', standing_kind: 'open_tab', project_name: 'App' })).toBe('Abrir abas no projeto App · sem prazo');
  expect(grantTitleLabel({ kind: 'standing', standing_kind: 'board', project_name: null })).toBe('Projeto que não existe mais');
});
