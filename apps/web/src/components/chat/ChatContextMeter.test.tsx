// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatContextMeter } from './ChatContextMeter';

afterEach(() => cleanup());

const meter = (over: Partial<Parameters<typeof ChatContextMeter>[0]> = {}) =>
  render(<ChatContextMeter tokens={25_258} window={1_000_000} compacting={false} canCompact onCompact={() => undefined} {...over} />);

it('shows the tokens in use, the window and the share', () => {
  meter();
  const m = screen.getByRole('meter', { name: 'Contexto da conversa' });
  expect(m).toHaveAttribute('aria-valuenow', '25258');
  expect(m).toHaveAttribute('aria-valuemax', '1000000');
  expect(m).toHaveTextContent('25 mil / 1 mi · 3%');
  expect(m.className).toContain('text-fg-dim');
});

it('is highlighted above 80%, and so is the button', () => {
  meter({ tokens: 170_000, window: 200_000 });
  expect(screen.getByRole('meter').className).toContain('text-warn');
  expect(screen.getByRole('meter')).toHaveAttribute('title', expect.stringContaining('Compacte a conversa'));
  expect(screen.getByRole('button', { name: 'Compactar' }).className).toContain('text-warn');
});

it('is red from 95%', () => {
  meter({ tokens: 196_000, window: 200_000 });
  expect(screen.getByRole('meter').className).toContain('text-danger');
});

it('without a window it shows the tokens alone, with no bar or share', () => {
  meter({ window: null });
  expect(screen.getByRole('meter')).toHaveTextContent(/^25 mil$/);
});

it('with no fill yet only the button is there', () => {
  meter({ tokens: null });
  expect(screen.queryByRole('meter')).toBeNull();
  expect(screen.getByRole('button', { name: 'Compactar' })).toBeInTheDocument();
});

it('the button compacts, names its shortcut, and says when it is compacting', () => {
  const onCompact = vi.fn();
  const { rerender } = meter({ onCompact });
  const button = screen.getByRole('button', { name: 'Compactar' });
  expect(button).toHaveAttribute('aria-keyshortcuts', 'Alt+Shift+C');
  fireEvent.click(button);
  expect(onCompact).toHaveBeenCalledTimes(1);
  rerender(<ChatContextMeter tokens={25_258} window={1_000_000} compacting canCompact={false} onCompact={onCompact} />);
  expect(screen.getByRole('button', { name: 'Compactando…' })).toBeDisabled();
});
