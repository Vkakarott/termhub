import { endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTabLabel, grantTitleLabel, activeGrantsLabel, STANDING_KIND_LABEL, standingKindLabel } from './labels';

it('counts active grants (tab and project together) in pt-BR', () => {
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
it('grantTitleLabel names a tab row by its tab, and a project row by its project (or that it is gone)', () => {
  expect(grantTitleLabel({ kind: 'project', tab_name: null, project_name: 'App' })).toBe('Quadro do projeto App');
  expect(grantTitleLabel({ kind: 'project', tab_name: null, project_name: null })).toBe('Projeto que não existe mais');
  expect(grantTitleLabel({ kind: 'tab', tab_name: 'api', project_name: 'App' })).toBe('Aba api');
});
it('grantTitleLabel names the wider grants (TER-325): "Aba X · teclas e shell" and "Tudo no projeto X"', () => {
  expect(grantTitleLabel({ kind: 'tab', tab_name: 'api', project_name: 'App', tool: 'terminal', scope: null })).toBe('Aba api · teclas e shell');
  expect(grantTitleLabel({ kind: 'tab', tab_name: 'api', project_name: 'App', tool: 'send_input', scope: null })).toBe('Aba api');
  expect(grantTitleLabel({ kind: 'tab', tab_name: null, project_name: null, tool: 'terminal', scope: null })).toBe('Aba que não existe mais · teclas e shell');
  expect(grantTitleLabel({ kind: 'project', tab_name: null, project_name: 'App', tool: null, scope: 'all' })).toBe('Tudo no projeto App');
  expect(grantTitleLabel({ kind: 'project', tab_name: null, project_name: 'App', tool: null, scope: 'board' })).toBe('Quadro do projeto App');
  expect(grantTitleLabel({ kind: 'project', tab_name: null, project_name: null, tool: null, scope: 'all' })).toBe('Projeto que não existe mais');
});
it('formats when it ended as dd/mm/aaaa hh:mm in local time', () => {
  const d = new Date(2026, 8, 5, 7, 3);
  expect(endedAtLabel(d.toISOString())).toBe('05/09/2026 07:03');
});

it('names a standing row by its kind and project, "sem prazo" — or that the project is gone (TER-386)', () => {
  expect(grantTitleLabel({ kind: 'standing', tab_name: null, project_name: 'App', standing_kind: 'close_tab' })).toBe('Fechar abas paradas no projeto App · sem prazo');
  expect(grantTitleLabel({ kind: 'standing', tab_name: null, project_name: 'App', standing_kind: 'terminal' })).toBe('Teclas e texto nas abas no projeto App · sem prazo');
  expect(grantTitleLabel({ kind: 'standing', tab_name: null, project_name: null, standing_kind: 'board' })).toBe('Projeto que não existe mais');
  expect(standingKindLabel('open_tab')).toBe('Abrir abas');
  expect(STANDING_KIND_LABEL.start_agent).toBe('iniciar agentes');
});
