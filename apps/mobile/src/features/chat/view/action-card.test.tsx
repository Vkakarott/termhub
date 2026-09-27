import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ChatAction } from '../model/types';
import { ActionCard } from './action-card';

const BASE_ACTION: ChatAction = {
  id: 'a1',
  tool: 'move_task',
  args: {},
  class: 'write',
  status: 'pending',
  machine_id: null,
  project_id: 'p-termhub',
  tab_id: null,
  grant_id: null,
  summary: 'mover a tarefa TER-12 "Revisar o login" do projeto termhub',
  created_at: new Date().toISOString(),
};

describe('ActionCard: "Permitir sempre neste projeto" (board grant, design spec 2026-09-26 §7)', () => {
  it('shows the button for a pending move_task and calls onDecide(id, approve_project)', async () => {
    const onDecide = jest.fn();
    await render(<ActionCard action={BASE_ACTION} busy={false} onDecide={onDecide} revoking={false} onRevoke={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Permitir sempre neste projeto' }));
    expect(onDecide).toHaveBeenCalledWith('a1', 'approve_project');
  });

  it('does not offer it for a tool outside the board set', async () => {
    await render(<ActionCard action={{ ...BASE_ACTION, tool: 'send_input', tab_id: 't-api' }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Permitir sempre neste projeto' })).toBeNull();
  });

  it('labels a call run under a project grant "executada · quadro confiado"', async () => {
    await render(<ActionCard action={{ ...BASE_ACTION, status: 'executed', grant_id: 'g1' }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText('executada · quadro confiado')).toBeTruthy();
  });

  it('shows the active project grant with "Permitido neste projeto até HH:MM" and revokes it', async () => {
    const projectGrant = { id: 'pg1', project_id: 'p-termhub', project_name: 'termhub', source_action_id: 'a1', created_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z' };
    const onRevoke = jest.fn();
    await render(<ActionCard action={{ ...BASE_ACTION, status: 'executed', grant_id: 'g1' }} busy={false} onDecide={jest.fn()} projectGrant={projectGrant} revoking={false} onRevoke={onRevoke} />);
    expect(screen.getByText(/^Permitido neste projeto/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Revogar' }));
    expect(onRevoke).toHaveBeenCalledWith('pg1');
  });
});
