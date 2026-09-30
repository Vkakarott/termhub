import { fireEvent, render, screen } from '@testing-library/react-native';
import type { TabLimit } from '../model/types';
import { TabLimitCard } from './tab-limit-card';

const OPEN: TabLimit = {
  id: 'l1',
  tab_id: 't-api',
  tab_name: 'api',
  payload: {
    account: { id: 'a1', label: 'Pessoal' },
    machine: { id: 'm1', name: 'jarvis' },
    resets_at: null,
    candidates: [
      { id: 'a2', label: 'Trabalho' },
      { id: 'a3', label: 'Reserva' },
    ],
  },
  status: 'open',
  result: null,
  created_at: '2026-09-30T10:00:00.000Z',
  closed_at: null,
};

describe('TabLimitCard (spec 2026-09-30 project AI accounts §7.2)', () => {
  it('says which account of which tab hit the limit, and offers each candidate in order, then "Esperar"', async () => {
    const onAnswer = jest.fn();
    await render(<TabLimitCard limit={OPEN} busy={false} onAnswer={onAnswer} />);
    expect(screen.getByText('Limite de uso da conta')).toBeTruthy();
    expect(screen.getByText('A conta Pessoal da aba api atingiu o limite de uso (cota de tokens esgotada). A troca automática está desligada na máquina jarvis.')).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.props.accessibilityLabel)).toEqual(['Trocar para Trabalho', 'Trocar para Reserva', 'Esperar']);

    await fireEvent.press(screen.getByRole('button', { name: 'Trocar para Reserva' }));
    expect(onAnswer).toHaveBeenLastCalledWith('l1', 'a3');
    await fireEvent.press(screen.getByRole('button', { name: 'Esperar' }));
    expect(onAnswer).toHaveBeenLastCalledWith('l1', null);
  });

  it('names the time the limit resets when the reading said', async () => {
    await render(<TabLimitCard limit={{ ...OPEN, payload: { ...OPEN.payload, resets_at: '2026-09-30T15:20:00.000Z' } }} busy={false} onAnswer={jest.fn()} />);
    expect(screen.getByText(/^A conta Pessoal da aba api atingiu o limite de uso \(cota de tokens esgotada\) até \d{2}:\d{2}\. A troca automática está desligada na máquina jarvis\.$/)).toBeTruthy();
  });

  it('disables its buttons while its answer is in flight, and shows why the last one failed', async () => {
    const onAnswer = jest.fn();
    await render(<TabLimitCard limit={OPEN} busy onAnswer={onAnswer} error="A aba não respondeu à troca." />);
    await fireEvent.press(screen.getByRole('button', { name: 'Esperar' }));
    expect(onAnswer).not.toHaveBeenCalled();
    expect(screen.getByText('A aba não respondeu à troca.')).toBeTruthy();
  });

  it('once closed, says how it ended and offers nothing', async () => {
    const { rerender } = await render(<TabLimitCard limit={{ ...OPEN, status: 'swapped', result: 'a2' }} busy={false} onAnswer={jest.fn()} />);
    expect(screen.getByText('Conta trocada para Trabalho.')).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    await rerender(<TabLimitCard limit={{ ...OPEN, status: 'dismissed' }} busy={false} onAnswer={jest.fn()} />);
    expect(screen.getByText('Você escolheu esperar o limite voltar.')).toBeTruthy();
    await rerender(<TabLimitCard limit={{ ...OPEN, status: 'expired' }} busy={false} onAnswer={jest.fn()} />);
    expect(screen.getByText('O limite passou ou a aba foi fechada.')).toBeTruthy();
    await rerender(<TabLimitCard limit={{ ...OPEN, status: 'failed' }} busy={false} onAnswer={jest.fn()} />);
    expect(screen.getByText('A troca não aconteceu.')).toBeTruthy();
  });

  it('reads without an account or a tab name', async () => {
    await render(<TabLimitCard limit={{ ...OPEN, tab_name: null, payload: { ...OPEN.payload, account: null } }} busy={false} onAnswer={jest.fn()} />);
    expect(screen.getByText('A conta atingiu o limite de uso (cota de tokens esgotada). A troca automática está desligada na máquina jarvis.')).toBeTruthy();
  });
});
