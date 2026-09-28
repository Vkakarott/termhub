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
    const projectGrant = { id: 'pg1', project_id: 'p-termhub', project_name: 'termhub', source_action_id: 'a1', created_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z', scope: 'board' as const };
    const onRevoke = jest.fn();
    await render(<ActionCard action={{ ...BASE_ACTION, status: 'executed', grant_id: 'g1' }} busy={false} onDecide={jest.fn()} projectGrant={projectGrant} revoking={false} onRevoke={onRevoke} />);
    expect(screen.getByText(/^Permitido neste projeto/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Revogar' }));
    expect(onRevoke).toHaveBeenCalledWith('pg1');
  });
});

describe('ActionCard: "Liberar teclas e shell nesta aba" / "Liberar tudo neste projeto" (TER-325)', () => {
  const SEND_KEY: ChatAction = { ...BASE_ACTION, tool: 'send_key', args: { tab_id: 't-api', key: '1' }, tab_id: 't-api' };

  it('offers both wider grants on a pending send_key to a tab, with their own decision words', async () => {
    const onDecide = jest.fn();
    await render(<ActionCard action={SEND_KEY} busy={false} onDecide={onDecide} revoking={false} onRevoke={jest.fn()} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Liberar teclas e shell nesta aba' }));
    expect(onDecide).toHaveBeenLastCalledWith('a1', 'approve_tab_terminal');
    await fireEvent.press(screen.getByRole('button', { name: 'Liberar tudo neste projeto' }));
    expect(onDecide).toHaveBeenLastCalledWith('a1', 'approve_project_all');
    // send_key has no narrow tab grant, and is not a board tool.
    expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Permitir sempre neste projeto' })).toBeNull();
  });

  it('offers both beside "Permitir sempre nesta aba" on a send_input to a tab', async () => {
    await render(<ActionCard action={{ ...SEND_KEY, tool: 'send_input', args: { tab_id: 't-api', text: 'npm test' } }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByRole('button', { name: 'Permitir sempre nesta aba' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Liberar tudo neste projeto' })).toBeTruthy();
  });

  it('offers neither on a send_input answering a permission dialog', async () => {
    await render(
      <ActionCard action={{ ...SEND_KEY, tool: 'send_input', args: { tab_id: 't-api', text: '1', answering_permission: true } }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Liberar tudo neste projeto' })).toBeNull();
  });

  it('offers only "Liberar tudo neste projeto" on a board card, and neither on run_command', async () => {
    await render(<ActionCard action={BASE_ACTION} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Liberar tudo neste projeto' })).toBeTruthy();
    await render(<ActionCard action={{ ...BASE_ACTION, tool: 'run_command', args: { command: 'ls' }, tab_id: null }} busy={false} onDecide={jest.fn()} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.queryByRole('button', { name: 'Liberar teclas e shell nesta aba' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Liberar tudo neste projeto' })).toBeNull();
  });

  it('shows a terminal tab grant as "Teclas e shell liberados até HH:MM", a narrow one as "Permitido até HH:MM"', async () => {
    const grant = { id: 'g1', tab_id: 't-api', tool: 'terminal', source_action_id: 'a1', created_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z', tab_name: 'api' };
    const executed = { ...SEND_KEY, status: 'executed' as const };
    await render(<ActionCard action={executed} busy={false} onDecide={jest.fn()} grant={grant} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText(/^Teclas e shell liberados até/)).toBeTruthy();
    await render(<ActionCard action={executed} busy={false} onDecide={jest.fn()} grant={{ ...grant, tool: 'send_input' }} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText(/^Permitido até/)).toBeTruthy();
  });

  it('shows an "all" project grant as "Tudo liberado neste projeto até HH:MM"', async () => {
    const projectGrant = { id: 'pg1', project_id: 'p-termhub', project_name: 'termhub', source_action_id: 'a1', created_at: new Date().toISOString(), expires_at: '2099-01-01T00:00:00.000Z', scope: 'all' as const };
    await render(<ActionCard action={{ ...SEND_KEY, status: 'executed' }} busy={false} onDecide={jest.fn()} projectGrant={projectGrant} revoking={false} onRevoke={jest.fn()} />);
    expect(screen.getByText(/^Tudo liberado neste projeto até/)).toBeTruthy();
  });
});
