// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabLimit } from '../../lib/types';
import { TabLimitCard, tabLimitText } from './TabLimitCard';

const limit = (over: Partial<TabLimit> = {}): TabLimit => ({
  id: 'n1', tab_id: 't1', tab_name: 'api', status: 'open', result: null, created_at: '2026-09-30T02:30:00.000Z', closed_at: null,
  payload: { account: { id: 'a1', label: 'pessoal' }, machine: { id: 'm1', name: 'jarvis' }, resets_at: null, candidates: [{ id: 'a2', label: 'trabalho' }, { id: 'a3', label: 'reserva' }] },
  ...over,
});

afterEach(cleanup);

describe('TabLimitCard', () => {
  it('says the quota ran out and that the machine does not swap by itself', () => {
    expect(tabLimitText(limit())).toBe('A conta pessoal da aba api atingiu o limite de uso (cota de tokens esgotada). A troca automática está desligada na máquina jarvis.');
    expect(tabLimitText(limit({ tab_name: null, payload: { ...limit().payload, account: null } }))).toBe('A conta atingiu o limite de uso (cota de tokens esgotada). A troca automática está desligada na máquina jarvis.');
  });

  it('offers one button per account, in order, and "Esperar"', () => {
    const onAnswer = vi.fn();
    render(<TabLimitCard limit={limit()} busy={false} onAnswer={onAnswer} />);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Trocar para trabalho', 'Trocar para reserva', 'Esperar']);
    fireEvent.click(screen.getByRole('button', { name: 'Trocar para reserva' }));
    fireEvent.click(screen.getByRole('button', { name: 'Esperar' }));
    expect(onAnswer.mock.calls).toEqual([['n1', 'a3'], ['n1', null]]);
  });

  it('disables the buttons while answering and shows the error', () => {
    render(<TabLimitCard limit={limit()} busy error="A sessão não pôde ser preparada" onAnswer={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Esperar' })).toBeDisabled();
    expect(screen.getByText('A sessão não pôde ser preparada')).toBeInTheDocument();
  });

  it('once closed, says what happened and offers nothing', () => {
    render(<TabLimitCard limit={limit({ status: 'swapped', result: 'a2' })} busy={false} onAnswer={vi.fn()} />);
    expect(screen.getByText('Conta trocada para trabalho.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
