// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_MS, ToastProvider, Toaster, useToast, type ToastInput } from './toast';

let api: ReturnType<typeof useToast>;

function Grab() {
  api = useToast();
  return null;
}

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function setup() {
  render(
    <MemoryRouter initialEntries={['/']}>
      <ToastProvider>
        <Grab />
        <Toaster />
        <Routes>
          <Route path="*" element={<Where />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const toast = (id: string, extra: Partial<ToastInput> = {}): ToastInput => ({ id, title: `Projeto › ${id}`, body: 'Posso seguir?', href: `/projects/p1?tab=${id}`, ...extra });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('toasts', () => {
  it('shows a toast and closes it by itself', () => {
    setup();
    act(() => api.show(toast('a')));
    expect(screen.getByText('Projeto › a')).toBeTruthy();
    act(() => vi.advanceTimersByTime(TOAST_MS + 10));
    expect(screen.queryByText('Projeto › a')).toBeNull();
  });

  it('keeps at most three, newest first, and replaces one with the same id', () => {
    setup();
    act(() => {
      api.show(toast('a'));
      api.show(toast('b'));
      api.show(toast('c'));
      api.show(toast('d'));
    });
    expect(screen.queryByText('Projeto › a')).toBeNull();
    expect(screen.getAllByRole('status').map((el) => el.querySelector('p')?.textContent)).toEqual(['Projeto › d', 'Projeto › c', 'Projeto › b']);
    act(() => api.show(toast('c', { body: 'outra pergunta' })));
    expect(screen.getAllByRole('status')).toHaveLength(3);
    expect(screen.getByText('outra pergunta')).toBeTruthy();
  });

  it('opens the tab on click and closes', () => {
    setup();
    act(() => api.show(toast('a')));
    fireEvent.click(screen.getByText('Projeto › a'));
    expect(screen.getByTestId('where').textContent).toBe('/projects/p1?tab=a');
    expect(screen.queryByText('Projeto › a')).toBeNull();
  });

  it('can be dismissed by id or by the close button', () => {
    setup();
    act(() => {
      api.show(toast('a'));
      api.show(toast('b'));
    });
    act(() => api.dismiss('a'));
    expect(screen.queryByText('Projeto › a')).toBeNull();
    fireEvent.click(screen.getByLabelText('Fechar aviso'));
    expect(screen.queryByText('Projeto › b')).toBeNull();
  });
});
