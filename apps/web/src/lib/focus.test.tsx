// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { FocusProvider, useFocusMode } from './focus';

afterEach(() => {
  cleanup();
});

function Probe() {
  const { focus, setFocus } = useFocusMode();
  const { search } = useLocation();
  return (
    <button onClick={() => setFocus(!focus)} data-search={search}>
      {focus ? 'on' : 'off'}
    </button>
  );
}
const mount = (url: string) => render(<MemoryRouter initialEntries={[url]}><FocusProvider><Probe /></FocusProvider></MemoryRouter>);

describe('focus mode', () => {
  it('reads ?focus=1 from the URL, so a reload keeps it', () => {
    mount('/office/m1?room=p1&focus=1');
    expect(screen.getByRole('button').textContent).toBe('on');
  });
  it('ignores ?focus=1 outside /office, where nothing would bring the sidebar back', () => {
    mount('/projects/p1?focus=1');
    expect(screen.getByRole('button').textContent).toBe('off');
  });
  it('writes the flag to the URL without losing the other params, and removes it when off', () => {
    mount('/office/m1?room=p1');
    const b = screen.getByRole('button');
    act(() => b.click());
    expect(b.textContent).toBe('on');
    expect(b.dataset.search).toBe('?room=p1&focus=1');
    act(() => b.click());
    expect(b.dataset.search).toBe('?room=p1');
  });
});
