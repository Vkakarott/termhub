// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CookieBanner } from './CookieBanner';
import { readConsent } from '../lib/consent';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('CookieBanner', () => {
  it('renders nothing when closed', () => {
    render(<CookieBanner open={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stores "granted" on accept', () => {
    render(<CookieBanner open />);
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(readConsent()).toBe('granted');
  });

  it('stores "denied" on decline', () => {
    render(<CookieBanner open />);
    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));
    expect(readConsent()).toBe('denied');
  });
});
