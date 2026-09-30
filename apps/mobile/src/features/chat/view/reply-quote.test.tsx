import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ReplyQuote } from './reply-quote';

afterEach(() => jest.useRealTimers());

describe('ReplyQuote (TER-447)', () => {
  it('shows who and what was quoted, and opens the original', async () => {
    const onOpen = jest.fn(() => true);
    await render(<ReplyQuote reply={{ id: 'm1', role: 'assistant', excerpt: 'Abri a aba build' }} onOpen={onOpen} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Ver mensagem original: Concierge, Abri a aba build' }));
    expect(onOpen).toHaveBeenCalledWith('m1');
    expect(screen.queryByText('Mensagem original indisponível')).toBeNull();
  });

  it('says the original is unavailable for a while when the screen does not have it', async () => {
    jest.useFakeTimers();
    await render(<ReplyQuote reply={{ id: 'old', role: 'user', excerpt: 'oi' }} onOpen={() => false} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Ver mensagem original: Você, oi' }));
    expect(screen.getByText('Mensagem original indisponível')).toBeTruthy();
    await act(async () => void jest.advanceTimersByTime(3000));
    expect(screen.queryByText('Mensagem original indisponível')).toBeNull();
  });

  it('a deleted original is unavailable without asking the screen', async () => {
    const onOpen = jest.fn(() => true);
    await render(<ReplyQuote reply={{ id: null, role: 'assistant', excerpt: 'oi' }} onOpen={onOpen} />);
    await fireEvent.press(screen.getByRole('button'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText('Mensagem original indisponível')).toBeTruthy();
  });
});
