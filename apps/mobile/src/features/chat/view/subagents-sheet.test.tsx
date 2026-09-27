import { fireEvent, render, screen } from '@testing-library/react-native';
import type { SubagentView } from '../model/types';
import { SubagentsSheet } from './subagents-sheet';

const sub = (over: Partial<SubagentView> & { id: string }): SubagentView => ({
  description: 'Buscar CI',
  subagent_type: null,
  status: 'running',
  started_at: '2026-09-27T00:00:00.000Z',
  ended_at: null,
  ...over,
});

const NOW = new Date('2026-09-27T00:03:00.000Z').getTime();

it('renders the description, the status and how long it has been running', async () => {
  await render(<SubagentsSheet open subagents={[sub({ id: 's1' })]} cancelFailed={[]} onCancel={jest.fn()} now={NOW} onClose={jest.fn()} />);
  expect(screen.getByText('Buscar CI')).toBeTruthy();
  expect(screen.getByText(/rodando/)).toBeTruthy();
  expect(screen.getByText(/há 3 min/)).toBeTruthy();
});

it('offers Cancelar only on running lines, named after the description, and calls onCancel with the id', async () => {
  const onCancel = jest.fn();
  await render(
    <SubagentsSheet
      open
      subagents={[sub({ id: 's1', description: 'Buscar CI' }), sub({ id: 's2', description: 'Ler logs', status: 'stopping' })]}
      cancelFailed={[]}
      onCancel={onCancel}
      now={NOW}
      onClose={jest.fn()}
    />,
  );
  const button = screen.getByRole('button', { name: 'Cancelar Buscar CI' });
  await fireEvent.press(button);
  expect(onCancel).toHaveBeenCalledWith('s1');
  expect(screen.queryByRole('button', { name: /Cancelar Ler logs/ })).toBeNull();
});

it('a stopping line reads "cancelando…" and shows no button', async () => {
  await render(<SubagentsSheet open subagents={[sub({ id: 's1', status: 'stopping' })]} cancelFailed={[]} onCancel={jest.fn()} now={NOW} onClose={jest.fn()} />);
  expect(screen.getByText(/cancelando…/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Cancelar/ })).toBeNull();
});

it('an id in cancelFailed shows "Não foi possível cancelar"', async () => {
  await render(<SubagentsSheet open subagents={[sub({ id: 's1' })]} cancelFailed={['s1']} onCancel={jest.fn()} now={NOW} onClose={jest.fn()} />);
  expect(screen.getByText('Não foi possível cancelar')).toBeTruthy();
});

it('closed (open=false) shows none of its rows', async () => {
  await render(<SubagentsSheet open={false} subagents={[sub({ id: 's1' })]} cancelFailed={[]} onCancel={jest.fn()} now={NOW} onClose={jest.fn()} />);
  expect(screen.queryByText('Buscar CI')).toBeNull();
});
