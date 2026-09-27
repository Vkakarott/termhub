// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatActionCard } from './ChatActionCard';
import type { ChatAction, ChatGrant } from '../../lib/types';

afterEach(() => cleanup());

const base: ChatAction = { id: 'a1', tool: 'send_input', args: { tab_id: 't1', text: 'oi' }, class: 'write', status: 'pending', machine_id: null, project_id: null, tab_id: 't1', summary: 'digitar `oi` na aba Terminal 1', created_at: '' };
const grant: ChatGrant = { id: 'g1', tab_id: 't1', tool: 'send_input', source_action_id: 'a1', created_at: '', expires_at: new Date(Date.now() + 3_600_000).toISOString(), tab_name: 'Terminal 1' };
const card = (over: Partial<ChatAction> = {}): ChatAction => ({ ...base, ...over });

it('offers "Permitir sempre nesta aba" on a pending send_input to a tab', () => {
  const onDecide = vi.fn();
  render(<ChatActionCard action={base} deciding={false} onDecide={onDecide} />);
  fireEvent.click(screen.getByRole('button', { name: 'Permitir sempre nesta aba' }));
  expect(onDecide).toHaveBeenCalledWith('a1', 'approve_tab');
});
it.each([
  ['answering a permission', { ...base, args: { tab_id: 't1', text: '1', answering_permission: true } }],
  ['run_command', { ...base, tool: 'run_command', args: { tab_id: 't1', command: 'ls' } }],
  ['no tab', { ...base, tab_id: null, args: { text: 'oi' } }],
])('does not offer it for %s', (_l, action) => {
  render(<ChatActionCard action={action as ChatAction} deciding={false} onDecide={vi.fn()} />);
  expect(screen.queryByRole('button', { name: 'Permitir sempre nesta aba' })).toBeNull();
});
it('the card that granted shows until when and revokes', () => {
  const onRevoke = vi.fn();
  render(<ChatActionCard action={{ ...base, status: 'executed' }} deciding={false} onDecide={vi.fn()} grant={grant} onRevoke={onRevoke} />);
  expect(screen.getByText(/^Permitido nesta aba até/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
  expect(onRevoke).toHaveBeenCalledWith('g1');
});
it('an action run under a grant reads "aba confiada"', () => {
  render(<ChatActionCard action={{ ...base, status: 'executed', grant_id: 'g1' }} deciding={false} onDecide={vi.fn()} />);
  expect(screen.getByText('Executado · aba confiada')).toBeInTheDocument();
});

it('offers "Permitir sempre neste projeto" on a pending board card only', () => {
  const onDecide = vi.fn();
  render(<ChatActionCard action={card({ tool: 'move_task', args: { task_id: 'k1' } })} deciding={false} onDecide={onDecide} />);
  fireEvent.click(screen.getByRole('button', { name: 'Permitir sempre neste projeto' }));
  expect(onDecide).toHaveBeenCalledWith('a1', 'approve_project');
  cleanup();
  render(<ChatActionCard action={card({ tool: 'delete_task', args: { task_id: 'k1' }, class: 'irreversible' })} deciding={false} onDecide={onDecide} />);
  expect(screen.queryByRole('button', { name: 'Permitir sempre neste projeto' })).toBeNull();
});

it('shows the project grant it created, with Revogar', () => {
  render(
    <ChatActionCard
      action={card({ tool: 'move_task', status: 'executed' })}
      projectGrant={{ id: 'pg1', project_id: 'p1', project_name: 'App', source_action_id: 'a1', created_at: 'x', expires_at: new Date(Date.now() + 3_600_000).toISOString() }}
      deciding={false}
      onDecide={vi.fn()}
      onRevoke={vi.fn()}
    />,
  );
  expect(screen.getByText(/Permitido neste projeto até/)).toBeInTheDocument();
});

it('labels a call run under a project grant', () => {
  render(<ChatActionCard action={card({ tool: 'update_task', status: 'executed', grant_id: 'pg1' })} deciding={false} onDecide={vi.fn()} />);
  expect(screen.getByText(/quadro confiado/)).toBeInTheDocument();
});

it('names the subagent that proposed the action', () => {
  render(<ChatActionCard action={{ ...base, subagent: { id: 's1', description: 'Buscar CI' } }} deciding={false} onDecide={vi.fn()} />);
  expect(screen.getByText('Pedido pelo subagente «Buscar CI»')).toBeInTheDocument();
});
it('no origin line without a subagent', () => {
  render(<ChatActionCard action={base} deciding={false} onDecide={vi.fn()} />);
  expect(screen.queryByText(/Pedido pelo subagente/)).toBeNull();
});
