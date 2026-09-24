import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useEscapeLayer } from '../components/Modal';

/** Addresses that used to be pages or Início tabs and now redirect into Configurações. */
const OLD_SETTINGS_PATHS = new Set(['/integrations', '/ai', '/hardware', '/waitlist']);

/**
 * Where the sidebar slot shows Configurações' own sidebar. `/integrations` counts too: it is the old
 * address of a settings section and only redirects there, so it must never be remembered as "the page
 * before settings" — going back to it would bounce straight into settings again.
 */
export function isSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/') || OLD_SETTINGS_PATHS.has(pathname);
}

/** Inputs that take typing (and so may use Esc themselves); a checkbox, radio, button or range does not. */
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'time', 'week']);

/** Esc belongs to where it was pressed when that is a text field, a select or a dialog. */
export function keepsEscape(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) {
    if (TEXT_INPUT_TYPES.has(target.type)) return true;
  } else if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return true;
  return !!target.closest('[role="dialog"], dialog');
}

/**
 * Remembers the last location outside settings (in memory: spec 2026-09-23 app chrome §7) and returns
 * the way back to it — `/` when settings was the first page opened. Esc takes the same way while under
 * settings, as the base layer of the Escape stack (components/Modal): a dialog opened over a section,
 * or the chat drawer, closes first. Call it once, in the layout, which stays mounted while the pages under it change.
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
  // a base layer: an open dialog or the chat drawer answers Esc before settings does
  useEscapeLayer(
    inside,
    (e) => {
      if (!keepsEscape(e.target)) leave();
    },
    true,
    { base: true },
  );
  return leave;
}
