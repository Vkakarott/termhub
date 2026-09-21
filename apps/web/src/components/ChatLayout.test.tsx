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

  it('names the page in its header, so the screen has a heading', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Chat' })).toBeTruthy();
  });

  it('puts the routed page in a main landmark, like every sidebar route', () => {
    mount();
    // /chat is a full page of its own, so it needs the landmark a screen reader skips the header by.
    expect(screen.getByRole('main').textContent).toContain('conteúdo do chat');
  });

  it('offers a labelled way back to the app', () => {
    mount();
    const back = screen.getByRole('link', { name: /voltar/i });
    expect(back.getAttribute('href')).toBe('/');
  });
});
