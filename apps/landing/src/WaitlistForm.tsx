import { useState, type FormEvent } from 'react';
import { useLang } from './i18n';

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done'; already: boolean } | { kind: 'error'; message: string };

const onlyDigits = (s: string) => s.replace(/\D+/g, '');

/** Cloudflare Access signs people in with Google, so only Gmail addresses can be invited. */
const GMAIL_RE = /^[^@\s]+@gmail\.com$/i;

/** Desaturated red, for form semantics only — it is not part of the page palette. */
const FORM_RED = '#d98b8b';

/** Posts to /api/waitlist on the same origin (nginx forwards termhub.dev/api/waitlist to the app). */
export function WaitlistForm() {
  const { t, lang } = useLang();
  const f = t.cloud.form;
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [ddi, setDdi] = useState(lang === 'pt' ? '55' : '1');
  const [ddd, setDdd] = useState('');
  const [number, setNumber] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [github, setGithub] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [state, setState] = useState<State>({ kind: 'idle' });

  const emailOk = GMAIL_RE.test(email.trim());
  const showEmailError = emailTouched && email.trim() !== '' && !emailOk;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState({ kind: 'sending' });
    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          first_name: first, last_name: last, email, phone_country: ddi, phone_area: ddd, phone_number: number,
          linkedin: linkedin || null, github: github || null, locale: lang, website,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; already?: boolean; error?: string; issues?: { message?: string }[] };
      if (!res.ok || !data.ok) {
        // the server rejects a non-Gmail address with a `gmail_only` zod issue
        const gmailOnly = res.status === 400 && (data.issues ?? []).some((i) => i.message === 'gmail_only');
        throw new Error(gmailOnly ? 'gmail_only' : data.error || `HTTP ${res.status}`);
      }
      setState({ kind: 'done', already: !!data.already });
    } catch (err) {
      const gmailOnly = err instanceof Error && err.message === 'gmail_only';
      setState({ kind: 'error', message: gmailOnly ? f.email_invalid : f.error });
    }
  };

  if (state.kind === 'done') {
    return (
      <div className="rounded-card border border-accent/40 bg-surface p-5">
        <p className="font-medium text-white">
          <span className="mr-2 text-accent" aria-hidden="true">✓</span>
          {state.already ? f.already : f.done_title}
        </p>
        {!state.already && <p className="mt-1 text-body-sm text-frost">{f.done_text}</p>}
      </div>
    );
  }

  const label = 'mb-1 block text-caption font-medium uppercase tracking-wide text-muted';
  const sending = state.kind === 'sending';

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="wl-first">{f.first}</label>
          <input id="wl-first" className="field" value={first} onChange={(e) => setFirst(e.target.value)} required maxLength={80} autoComplete="given-name" />
        </div>
        <div>
          <label className={label} htmlFor="wl-last">{f.last}</label>
          <input id="wl-last" className="field" value={last} onChange={(e) => setLast(e.target.value)} required maxLength={80} autoComplete="family-name" />
        </div>
      </div>
      <div className="relative">
        <div className="mb-1 flex items-center gap-1">
          <label className="text-caption font-medium uppercase tracking-wide text-muted" htmlFor="wl-email">{f.email}</label>
          <button
            type="button"
            className="peer text-[16px] leading-none text-muted transition duration-150 hover:text-frost focus:text-frost focus:outline-none"
            aria-label={f.email_tooltip}
            aria-describedby="wl-email-tip"
          >
            <span aria-hidden="true">ⓘ</span>
          </button>
          <span
            id="wl-email-tip"
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-0 z-20 mb-2 w-full max-w-[280px] rounded-field border border-border-2 bg-surface px-3 py-2 text-caption font-normal normal-case tracking-normal text-frost opacity-0 transition-opacity duration-150 peer-hover:opacity-100 peer-focus:opacity-100"
          >
            {f.email_tooltip}
          </span>
        </div>
        <input
          id="wl-email"
          className="field"
          type="email"
          inputMode="email"
          placeholder={f.email_placeholder}
          pattern="[^@\s]+@gmail\.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setEmailTouched(true)}
          aria-invalid={showEmailError}
          required
          maxLength={200}
          autoComplete="email"
        />
        {showEmailError && <p className="mt-1 text-caption" style={{ color: FORM_RED }}>{f.email_invalid}</p>}
      </div>
      <div>
        <span className={label}>{f.phone}</span>
        <div className="grid grid-cols-[5rem_5rem_1fr] gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-body-sm text-muted">+</span>
            <input className="field pl-6" inputMode="numeric" placeholder={f.ddi} aria-label={f.ddi} value={ddi} onChange={(e) => setDdi(onlyDigits(e.target.value).slice(0, 4))} required autoComplete="tel-country-code" />
          </div>
          <input className="field" inputMode="numeric" placeholder={f.ddd} aria-label={f.ddd} value={ddd} onChange={(e) => setDdd(onlyDigits(e.target.value).slice(0, 5))} required autoComplete="tel-area-code" />
          <input className="field" inputMode="numeric" placeholder={f.number} aria-label={f.number} value={number} onChange={(e) => setNumber(onlyDigits(e.target.value).slice(0, 12))} required autoComplete="tel-local" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="wl-linkedin">{f.linkedin}</label>
          <input id="wl-linkedin" className="field" value={linkedin} onChange={(e) => setLinkedin(e.target.value)} placeholder={f.handle_hint} maxLength={200} />
        </div>
        <div>
          <label className={label} htmlFor="wl-github">{f.github}</label>
          <input id="wl-github" className="field" value={github} onChange={(e) => setGithub(e.target.value)} placeholder={f.handle_hint} maxLength={200} />
        </div>
      </div>
      {/* honeypot: hidden from people, filled by bots */}
      <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
      </div>
      {state.kind === 'error' && <p className="text-body-sm" style={{ color: FORM_RED }}>{state.message}</p>}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button
          type="submit"
          className="btn-primary px-4 py-2 text-body-sm disabled:cursor-not-allowed disabled:opacity-50"
          disabled={sending || !first || !last || !emailOk || !ddi || !ddd || number.length < 6}
        >
          {sending ? f.sending : f.submit}
        </button>
        <span className="text-caption text-muted">{f.privacy}</span>
      </div>
    </form>
  );
}
