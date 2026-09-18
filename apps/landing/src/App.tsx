import { useEffect, useState } from 'react';
import { DICT, LANG_KEY, LangContext, detectLang, useLang, type Lang } from './i18n';
import { WaitlistForm } from './WaitlistForm';

const APP_URL = 'https://app.termhub.dev';
const REPO_URL = 'https://github.com/engenhariainversa/termhub';
const COFFEE_URL = 'https://buymeacoffee.com/pedrogoiania';

const FEATURE_ICONS = ['▮_', '⌂', '✦', '▦', '◔', '◫'];

function Logo({ className = 'h-10' }: { className?: string }) {
  return <img src="/logo.svg" alt="termhub" className={className} />;
}

function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <span className="flex rounded border border-line p-0.5 text-xs" role="group" aria-label="Language">
      {(['pt', 'en'] as Lang[]).map((l) => (
        <button key={l} type="button" onClick={() => setLang(l)} className={`rounded px-2 py-0.5 uppercase ${lang === l ? 'bg-accent/20 text-fg' : 'text-fg-muted hover:text-fg'}`} aria-pressed={lang === l}>
          {l}
        </button>
      ))}
    </span>
  );
}

function TerminalMock() {
  const { t } = useLang();
  const lines: { c: string; t: string }[] = [
    { c: 'text-fg-dim', t: '# jarvis › meu-app › tab 1' },
    { c: 'text-accent-2', t: '❯ claude' },
    { c: 'text-fg-muted', t: '✻ Claude Code · /Users/pedro/projetos/meu-app' },
    { c: 'text-fg-dim', t: '' },
    { c: 'text-fg', t: `> ${t.mock.prompt}` },
    { c: 'text-fg-dim', t: '  ~/.cache/termhub/paste/paste-…-screenshot.png' },
    { c: 'text-ok', t: '✓ Read  src/auth/login.ts' },
    { c: 'text-ok', t: '✓ Edit  src/auth/login.ts' },
    { c: 'text-warn', t: '● Bash  npm test' },
  ];
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-bg-2 shadow-2xl">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-danger" />
        <span className="h-2.5 w-2.5 rounded-full bg-warn" />
        <span className="h-2.5 w-2.5 rounded-full bg-ok" />
        <span className="ml-3 flex gap-1 text-[11px]">
          <span className="rounded bg-accent/15 px-2 py-0.5 text-fg">claude</span>
          <span className="rounded px-2 py-0.5 text-fg-dim">server</span>
          <span className="rounded px-2 py-0.5 text-fg-dim">logs</span>
        </span>
        <span className="ml-auto text-[10px] text-fg-dim">tmux · UTF-8</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-5">
        {lines.map((l, i) => (
          <div key={i} className={l.c}>
            {l.t}
          </div>
        ))}
        <div className="text-fg">
          <span className="inline-block h-4 w-2 animate-pulse bg-fg align-middle" />
        </div>
      </pre>
      <div className="flex items-center gap-2 border-t border-line bg-bg-2 px-3 py-1 text-[11px] text-fg-dim">
        <span className="rounded bg-ok/15 px-1.5 text-ok">{t.mock.status}</span>
        <span>{t.mock.hint}</span>
        <span className="ml-auto font-mono">tmux</span>
      </div>
    </div>
  );
}

function Page() {
  const { t } = useLang();
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <a href="#" aria-label="termhub">
            <Logo className="h-8" />
          </a>
          <nav className="ml-auto hidden items-center gap-5 text-sm text-fg-muted sm:flex">
            <a href="#recursos" className="hover:text-fg">{t.nav.features}</a>
            <a href="#como-funciona" className="hover:text-fg">{t.nav.how}</a>
            <a href="#cloud" className="hover:text-fg">{t.nav.cloud}</a>
            <a href={REPO_URL} className="hover:text-fg">{t.nav.github}</a>
          </nav>
          <LangSwitch />
          <a href={APP_URL} className="btn-primary">{t.nav.app}</a>
        </div>
      </header>

      <main>
        {/* hero */}
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pb-16 pt-14 md:grid-cols-2 md:pt-20">
          <div>
            <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-bg-2 px-3 py-1 text-xs text-fg-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" /> {t.hero.badge}
            </p>
            <h1 className="text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              {t.hero.title_a}
              <span className="bg-gradient-to-r from-accent to-accent-2 bg-clip-text text-transparent">{t.hero.title_b}</span>.
            </h1>
            <p className="mt-4 max-w-xl text-lg text-fg-muted">{t.hero.lead}</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a href={APP_URL} className="btn-primary">{t.hero.cta}</a>
              <a href={REPO_URL} className="btn-ghost">{t.hero.repo}</a>
            </div>
            <p className="mt-5 text-xs text-fg-dim">
              <span className="kbd">⌘T</span> {t.hero.keys.tab} · <span className="kbd">⌘1..9</span> {t.hero.keys.switch} · <span className="kbd">⌘V</span> {t.hero.keys.paste}
            </p>
          </div>
          <TerminalMock />
        </section>

        {/* features */}
        <section id="recursos" className="border-t border-line bg-bg-2/40">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 className="text-2xl font-semibold tracking-tight">{t.features.title}</h2>
            <p className="mt-2 max-w-2xl text-fg-muted">{t.features.lead}</p>
            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {t.features.items.map((f, i) => (
                <li key={f.title} className="rounded-lg border border-line bg-bg-2 p-5">
                  <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md bg-accent/15 font-mono text-sm text-accent">{FEATURE_ICONS[i]}</div>
                  <h3 className="font-medium">{f.title}</h3>
                  <p className="mt-1.5 text-sm text-fg-muted">{f.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* how it works */}
        <section id="como-funciona" className="mx-auto max-w-6xl px-4 py-16">
          <h2 className="text-2xl font-semibold tracking-tight">{t.how.title}</h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-3">
            {t.how.steps.map((s, i) => (
              <li key={s.title} className="relative rounded-lg border border-line bg-bg-2 p-5 pt-6">
                <span className="absolute -top-3 left-5 flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs font-semibold text-white">{i + 1}</span>
                <h3 className="font-medium">{s.title}</h3>
                <p className="mt-1.5 text-sm text-fg-muted">{s.text}</p>
              </li>
            ))}
          </ol>
          <div className="mt-8 rounded-lg border border-line bg-bg-2 p-5">
            <p className="mb-2 text-xs uppercase tracking-wide text-fg-dim">{t.how.stack_label}</p>
            <p className="text-sm text-fg-muted">{t.how.stack}</p>
          </div>
        </section>

        {/* cloud + waitlist */}
        <section id="cloud" className="border-t border-line bg-gradient-to-b from-accent/5 to-transparent">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 md:grid-cols-2">
            <div>
              <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-xs text-fg">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> {t.cloud.badge}
              </p>
              <h2 className="text-3xl font-semibold tracking-tight">{t.cloud.title}</h2>
              <p className="mt-3 max-w-xl text-fg-muted">{t.cloud.lead}</p>
              <ul className="mt-5 space-y-2 text-sm">
                {t.cloud.perks.map((p) => (
                  <li key={p} className="flex gap-2">
                    <span className="mt-0.5 text-ok">✓</span>
                    <span className="text-fg-muted">{p}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="relative rounded-lg border border-line bg-bg-2 p-5">
              <h3 className="mb-4 font-medium">{t.cloud.form.title}</h3>
              <WaitlistForm />
            </div>
          </div>
        </section>

        {/* cta */}
        <section className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col items-start gap-4 px-4 py-14 md:flex-row md:items-center">
            <div>
              <h2 className="text-xl font-semibold tracking-tight">{t.cta.title}</h2>
              <p className="mt-1 text-fg-muted">{t.cta.lead}</p>
            </div>
            <div className="flex gap-3 md:ml-auto">
              <a href={`${REPO_URL}#production-docker`} className="btn-primary">{t.cta.install}</a>
              <a href={APP_URL} className="btn-ghost">{t.cta.app}</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-xs text-fg-dim">
          <span>© {new Date().getFullYear()} termhub · MIT</span>
          <a href={REPO_URL} className="hover:text-fg">GitHub</a>
          <a href={`${REPO_URL}/blob/main/README.md`} className="hover:text-fg">{t.footer.docs}</a>
          <a href={COFFEE_URL} className="hover:text-fg">{t.footer.coffee}</a>
          <span className="ml-auto">{t.footer.made}</span>
        </div>
      </footer>
    </div>
  );
}

export function App() {
  const [lang, setLangState] = useState<Lang>(detectLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
  };
  useEffect(() => {
    document.documentElement.lang = lang === 'pt' ? 'pt-BR' : 'en';
    document.title = DICT[lang].meta.title;
  }, [lang]);
  return <LangContext.Provider value={{ lang, t: DICT[lang], setLang }}>{<Page />}</LangContext.Provider>;
}
