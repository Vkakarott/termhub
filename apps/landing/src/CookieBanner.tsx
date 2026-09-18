import { writeConsent } from './consent';
import { useLang } from './i18n';

/**
 * Cookie notice for the landing's Google Analytics.
 *
 * Deliberately not a modal: no overlay, the page stays usable and scrollable
 * while it is open. Writing the choice fires the consent event the app listens
 * to, which is what closes the banner and (on "accept") starts analytics.
 */
export function CookieBanner({ open }: { open: boolean }) {
  const { t } = useLang();
  if (!open) return null;
  const c = t.cookies;
  return (
    <div
      role="dialog"
      aria-labelledby="cookie-title"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-30 rounded-card border border-border-2 bg-surface p-5 shadow-rim md:left-auto md:right-6 md:max-w-md"
    >
      <h2 id="cookie-title" className="text-body">{c.title}</h2>
      <p className="mt-1.5 text-body-sm text-frost">{c.text}</p>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="button" className="btn-primary px-4 py-2 text-body-sm" onClick={() => writeConsent('granted')}>
          {c.accept}
        </button>
        <button type="button" className="btn-ghost px-4 py-2 text-body-sm" onClick={() => writeConsent('denied')}>
          {c.decline}
        </button>
      </div>
    </div>
  );
}
