import type { TChatEvent } from '@/services/api/contract';
import { localRowId, syntheticConfirmationRow } from './synthetic-row';

const confirmation: Extract<TChatEvent, { type: 'confirmation' }> = {
  type: 'confirmation',
  user_id: 'u1',
  conversation_id: 'c-termhub',
  action_id: 'a-new',
  tool: 'send_input',
  args: {},
  class: 'write',
  machine_id: 'm-jarvis',
  project_id: 'p-termhub',
  tab_id: 't-api',
  summary: 'digitar comando na aba api',
  created_at: '2026-09-24T12:00:00.000Z',
};

describe('syntheticConfirmationRow', () => {
  it('names the project in the body when the caller knows it', () => {
    const row = syntheticConfirmationRow(confirmation, 'termhub', 1758715200000);
    expect(row).toMatchObject({
      id: localRowId('a-new'),
      kind: 'confirmation',
      title: 'termhub precisa de você',
      body: 'O chat do projeto termhub pediu confirmação para agir.',
      data: { conversation_id: 'c-termhub', project_id: 'p-termhub', action_id: 'a-new' },
      read_at: null,
    });
  });

  it('falls back to the account-wide sentence when the project name is unknown', () => {
    const row = syntheticConfirmationRow({ ...confirmation, project_id: null }, null, 1758715200000);
    expect(row.body).toBe('O chat geral pediu confirmação para agir.');
  });
});
