// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CityErrorBoundary } from './CityErrorBoundary';

function Boom(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'map')");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('CityErrorBoundary', () => {
  it('draws its children while nothing fails', () => {
    render(
      <CityErrorBoundary>
        <p>a cidade</p>
      </CityErrorBoundary>,
    );
    expect(screen.getByText('a cidade')).toBeTruthy();
  });

  // review fix: a page that throws while drawing (a snapshot of a shape this bundle does not know,
  // after a deploy) says so and offers the reload that fixes it, instead of a blank page
  it('replaces a page that threw with a message and a reload button', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      render(
        <CityErrorBoundary>
          <Boom />
        </CityErrorBoundary>,
      );
      expect(screen.getByText('Algo mudou por aqui. Recarregue a página.')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Recarregar' }));
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});
