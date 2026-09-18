import { useState, type FormEvent } from 'react';
import { useLang } from './i18n';

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'done'; already: boolean } | { kind: 'error'; message: string };

const onlyDigits = (s: string) => s.replace(/\D+/g, '');

/** Posts to /api/waitlist on the same origin (nginx forwards termhub.dev/api/waitlist to the app). */
export function WaitlistForm() {
  const { t, lang } = useLang();
  const f = t.cloud.form;
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [ddi, setDdi] = useState(lang === 'pt' ? '55' : '1');
  const [ddd, setDdd] = useState('');
  const [number, setNumber] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [github, setGithub] = useState('');
  const [website, setWebsite] = useState(''); // honeypot
  const [state, setState] = useState<State>({ kind: 'idle' });

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
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; already?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState({ kind: 'done', already: !!data.already });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error && err.message.startsWith('HTTP') ? f.error : f.error });
    }
  };

  if (state.kind === 'done') {
    return (
      <div className="rounded-lg border border-ok/40 bg-ok/10 p-5">
        <p className="font-medium text-fg">{state.already ? f.already : f.done_title}</p>
        {!state.already && <p className="mt-1 text-sm text-fg-muted">{f.done_text}</p>}
      </div>
    );
  }

  const input = 'w-full rounded-md border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent';
  const label = 'mb-1 block text-xs font-medium uppercase tracking-wide text-fg-muted';
  const sending = state.kind === 'sending';

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="wl-first">{f.first}</label>
          <input id="wl-first" className={input} value={first} onChange={(e) => setFirst(e.target.value)} required maxLength={80} autoComplete="given-name" />
        </div>
        <div>
          <label className={label} htmlFor="wl-last">{f.last}</label>
          <input id="wl-last" className={input} value={last} onChange={(e) => setLast(e.target.value)} required maxLength={80} autoComplete="family-name" />
        </div>
      </div>
      <div>
        <label className={label} htmlFor="wl-email">{f.email}</label>
        <input id="wl-email" className={input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={200} autoComplete="email" />
      </div>
      <div>
        <span className={label}>{f.phone}</span>
        <div className="grid grid-cols-[5rem_5rem_1fr] gap-2">
          <div className="relative">
            <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-fg-dim">+</span>
            <input className={`${input} pl-5`} inputMode="numeric" placeholder={f.ddi} aria-label={f.ddi} value={ddi} onChange={(e) => setDdi(onlyDigits(e.target.value).slice(0, 4))} required autoComplete="tel-country-code" />
          </div>
          <input className={input} inputMode="numeric" placeholder={f.ddd} aria-label={f.ddd} value={ddd} onChange={(e) => setDdd(onlyDigits(e.target.value).slice(0, 5))} required autoComplete="tel-area-code" />
          <input className={input} inputMode="numeric" placeholder={f.number} aria-label={f.number} value={number} onChange={(e) => setNumber(onlyDigits(e.target.value).slice(0, 12))} required autoComplete="tel-local" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="wl-linkedin">{f.linkedin}</label>
          <input id="wl-linkedin" className={input} value={linkedin} onChange={(e) => setLinkedin(e.target.value)} placeholder={f.handle_hint} maxLength={200} />
        </div>
        <div>
          <label className={label} htmlFor="wl-github">{f.github}</label>
          <input id="wl-github" className={input} value={github} onChange={(e) => setGithub(e.target.value)} placeholder={f.handle_hint} maxLength={200} />
        </div>
      </div>
      {/* honeypot: hidden from people, filled by bots */}
      <div className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
        <input tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} name="website" />
      </div>
      {state.kind === 'error' && <p className="text-sm text-danger">{state.message}</p>}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <button type="submit" className="btn-primary" disabled={sending || !first || !last || !email || !ddi || !ddd || number.length < 6}>
          {sending ? f.sending : f.submit}
        </button>
        <span className="text-xs text-fg-dim">{f.privacy}</span>
      </div>
    </form>
  );
}
