// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatLayout } from './ChatLayout';

function Marker() {
  return <p>conteúdo do chat</p>;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/chat']}>
      <Routes>
        <Route element={<ChatLayout />}>
          <Route path="/chat" element={<Marker />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe('ChatLayout', () => {
  it('renders the routed child', () => {
    mount();
    expect(screen.getByText('conteúdo do chat')).toBeTruthy();
  });

  it('renders no nav (sem menus)', () => {
    mount();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('offers a labelled way back to the app', () => {
    mount();
    const back = screen.getByRole('link', { name: /voltar/i });
    expect(back.getAttribute('href')).toBe('/');
  });
});
