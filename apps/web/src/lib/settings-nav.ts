import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useEscapeLayer } from '../components/Modal';

/**
 * Where the sidebar slot shows Configurações' own sidebar. `/integrations` counts too: it is the old
 * address of a settings section and only redirects there, so it must never be remembered as "the page
 * before settings" — going back to it would bounce straight into settings again.
 */
export function isSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/') || pathname === '/integrations';
}

/** Esc belongs to where it was pressed when that is a text field, a select or a dialog. */
export function keepsEscape(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return true;
  return !!target.closest('[role="dialog"], dialog');
}

/**
 * Remembers the last location outside settings (in memory: spec 2026-09-23 app chrome §7) and returns
 * the way back to it — `/` when settings was the first page opened. Esc takes the same way while under
 * settings, as one layer of the Escape stack (components/Modal): a dialog opened over a section closes
 * first. Call it once, in the layout, which stays mounted while the pages under it change.
 */
export function useSettingsExit(): () => void {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const inside = isSettingsPath(pathname);
  const lastOutside = useRef<string | null>(null);
  useEffect(() => {
    if (!inside) lastOutside.current = `${pathname}${search}`;
  }, [inside, pathname, search]);
  const leave = useCallback(() => {
    void navigate(lastOutside.current ?? '/');
  }, [navigate]);
  useEscapeLayer(inside, (e) => {
    if (!keepsEscape(e.target)) leave();
  });
  return leave;
}
