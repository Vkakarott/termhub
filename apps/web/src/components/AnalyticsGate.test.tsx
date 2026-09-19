// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analytics = vi.hoisted(() => ({
  enabled: true,
  initAnalytics: vi.fn(),
  disableAnalytics: vi.fn(),
  trackPageView: vi.fn(),
}));

vi.mock('../lib/analytics', () => ({
  get ANALYTICS_ENABLED() {
    return analytics.enabled;
  },
  initAnalytics: analytics.initAnalytics,
  disableAnalytics: analytics.disableAnalytics,
  trackPageView: analytics.trackPageView,
}));

import { AnalyticsGate, openCookieBanner } from './AnalyticsGate';
import { writeConsent } from '../lib/consent';

function Nav() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate('/projects/p1')}>
      go
    </button>
  );
}

function mount(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AnalyticsGate>
        <Routes>
          <Route path="*" element={<Nav />} />
        </Routes>
      </AnalyticsGate>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  analytics.enabled = true;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('AnalyticsGate', () => {
  it('asks for consent when nothing is stored', () => {
    mount();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(analytics.initAnalytics).not.toHaveBeenCalled();
  });

  it('renders no banner and never initialises when analytics is off', () => {
    analytics.enabled = false;
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(analytics.initAnalytics).not.toHaveBeenCalled();
  });

  it('starts analytics on a stored "granted" without asking again', () => {
    writeConsent('granted');
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(analytics.initAnalytics).toHaveBeenCalledTimes(1);
  });

  it('closes the banner and starts analytics on accept', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Aceitar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(analytics.initAnalytics).toHaveBeenCalledTimes(1);
  });

  it('closes the banner and disables analytics on decline', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Recusar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(analytics.disableAnalytics).toHaveBeenCalledTimes(1);
    expect(analytics.initAnalytics).not.toHaveBeenCalled();
  });

  it('reports the initial route and every route change', () => {
    writeConsent('granted');
    mount('/settings');
    expect(analytics.trackPageView).toHaveBeenCalledWith('/settings');
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(analytics.trackPageView).toHaveBeenLastCalledWith('/projects/p1');
    expect(analytics.trackPageView).toHaveBeenCalledTimes(2);
  });

  it('reopens the banner on openCookieBanner so the choice can be changed', () => {
    writeConsent('denied');
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => openCookieBanner());
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
