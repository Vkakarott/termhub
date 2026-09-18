import { useEffect, useState, type ReactNode } from 'react';
import { ANALYTICS_ENABLED, disableAnalytics, initAnalytics, setLang as setAnalyticsLang, track } from './analytics';
import { CookieBanner } from './CookieBanner';
import { readConsent, subscribeConsent } from './consent';
import { HeroCarousel } from './HeroCarousel';
import { DICT, LANG_KEY, LangContext, detectLang, useLang, type Lang } from './i18n';
import { useReveal } from './useReveal';
import { WaitlistForm } from './WaitlistForm';

const APP_URL = 'https://app.termhub.dev';
const REPO_URL = 'https://github.com/engenhariainversa/termhub';
const COFFEE_URL = 'https://buymeacoffee.com/pedrogoiania';

const FEATURE_ICONS = ['▮_', '⌂', '✦', '▦', '◔', '◫'];

/** Tiles fade up in sequence, capped so the last one never feels late. */
const revealDelay = (index: number) => ({ transitionDelay: `${Math.min(index * 60, 300)}ms` });

/** Click handler for the page's calls to action; the navigation itself is untouched. */
const trackCta = (target: string, location: string) => () => track('cta_click', { target, location });

function Logo({ className = 'h-10' }: { className?: string }) {
  return <img src="/logo.svg" alt="termhub" className={className} />;
}

function Chevron() {
  return <span aria-hidden="true">›</span>;
}

function SectionLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="section-link">
      {children} <Chevron />
    </a>
  );
}

function LangSwitch() {
  const { lang, setLang } = useLang();
  return (
    <span className="flex rounded-field border border-border-2 p-0.5 text-caption" role="group" aria-label="Language">
      {(['pt', 'en'] as Lang[]).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLang(l)}
          className={`hover-tint px-2 py-0.5 font-medium uppercase ${lang === l ? 'bg-surface text-white' : 'text-muted hover:text-frost'}`}
          aria-pressed={lang === l}
        >
          {l}
        </button>
      ))}
    </span>
  );
}

function FeatureTile({ icon, title, text, index }: { icon: string; title: string; text: string; index: number }) {
  const ref = useReveal<HTMLLIElement>();
  return (
    <li ref={ref} style={revealDelay(index)} className="reveal rounded-card border border-border-2 bg-surface p-5 hover:border-border/40">
      <span className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-field bg-border-2 font-mono text-body-sm text-accent">{icon}</span>
      <h3 className="text-body">{title}</h3>
      <p className="mt-1.5 text-body-sm text-frost">{text}</p>
    </li>
  );
}

function StepCard({ step, title, text, index }: { step: number; title: string; text: string; index: number }) {
  const ref = useReveal<HTMLLIElement>();
  return (
    <li ref={ref} style={revealDelay(index)} className="reveal relative rounded-card border border-border-2 bg-surface p-5 pt-6 hover:border-border/40">
      <span className="absolute -top-3 left-5 flex h-6 w-6 items-center justify-center rounded-full bg-border-2 text-caption font-medium text-accent">{step}</span>
      <h3 className="text-body">{title}</h3>
      <p className="mt-1.5 text-body-sm text-frost">{text}</p>
    </li>
  );
}

function Numbers() {
  const { t } = useLang();
  const ref = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} className="reveal mt-10 grid gap-5 sm:grid-cols-3">
      {t.numbers.map((n) => (
        <div key={n.label}>
          <p className="text-heading-lg font-medium text-white">{n.value}</p>
          <p className="mt-1.5 text-body-sm text-frost">{n.label}</p>
        </div>
      ))}
    </div>
  );
}

function FinalCta() {
  const { t } = useLang();
  const ref = useReveal<HTMLDivElement>();
  return (
    <section className="mx-auto max-w-page px-4 pb-20 md:px-6">
      <div ref={ref} className="reveal flex flex-col gap-5 rounded-card border border-border-2 bg-surface p-7 md:flex-row md:items-center md:p-9">
        <div>
          <h2 className="text-heading-sm">{t.cta.title}</h2>
          <p className="mt-1 max-w-2xl text-body text-frost">{t.cta.lead}</p>
        </div>
        <div className="flex flex-wrap gap-3 md:ml-auto md:shrink-0">
          <a href={`${REPO_URL}#production-docker`} className="btn-primary" onClick={trackCta('install', 'cta')}>{t.cta.install}</a>
          <a href={APP_URL} className="btn-ghost" onClick={trackCta('app', 'cta')}>{t.cta.app}</a>
        </div>
      </div>
    </section>
  );
}

function Page({ onOpenCookies }: { onOpenCookies: () => void }) {
  const { t } = useLang();
  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 bg-canvas/85 shadow-rim backdrop-blur">
        <div className="mx-auto flex h-14 max-w-page items-center px-4 md:px-6">
          <a href="#" aria-label="termhub" className="hover-tint px-1 py-1">
            <Logo className="h-7" />
          </a>
          <nav className="ml-6 hidden items-center gap-1 md:flex">
            <a href="#recursos" className="nav-link">{t.nav.features}</a>
            <a href="#como-funciona" className="nav-link">{t.nav.how}</a>
            <a href="#cloud" className="nav-link">{t.nav.cloud}</a>
            <a href={REPO_URL} className="nav-link">{t.nav.github}</a>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <LangSwitch />
            <a href={REPO_URL} className="btn-ghost hidden px-4 py-1.5 text-body-sm md:inline-flex" onClick={trackCta('github', 'nav')}>{t.hero.repo}</a>
            <a href={APP_URL} className="btn-primary px-4 py-1.5 text-body-sm" onClick={trackCta('app', 'nav')}>{t.nav.app}</a>
          </div>
        </div>
      </header>

      <main>
        {/* hero */}
        <section className="mx-auto grid max-w-page items-center gap-10 px-4 pb-16 pt-14 md:grid-cols-2 md:px-6 md:pt-20">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-field border border-border-2 bg-canvas px-3 py-1 text-caption text-frost">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> {t.hero.badge}
            </p>
            <h1 className="text-heading-lg [text-wrap:balance] md:text-[44px] lg:text-[48px] xl:text-[50px]">
              {t.hero.title_a}
              <span className="text-accent">{t.hero.title_b}</span>.
            </h1>
            <p className="mt-5 max-w-xl text-subheading text-frost">{t.hero.lead}</p>
            <div className="mt-7 flex flex-wrap gap-3">
              <a href={APP_URL} className="btn-primary" onClick={trackCta('app', 'hero')}>{t.hero.cta}</a>
              <a href={REPO_URL} className="btn-ghost" onClick={trackCta('github', 'hero')}>
                {t.hero.repo} <Chevron />
              </a>
            </div>
            <p className="mt-6 text-caption text-muted">
              <span className="kbd">⌘T</span> {t.hero.keys.tab} · <span className="kbd">⌘1..9</span> {t.hero.keys.switch} · <span className="kbd">⌘V</span> {t.hero.keys.paste}
            </p>
          </div>
          <HeroCarousel />
        </section>

        {/* features + numbers */}
        <section id="recursos">
          <div className="mx-auto max-w-page px-4 py-20 md:px-6">
            <SectionLink href={`${REPO_URL}#readme`}>{t.features.link}</SectionLink>
            <h2 className="mt-4 text-heading-lg">{t.features.title}</h2>
            <p className="mt-4 max-w-2xl text-subheading text-frost">{t.features.lead}</p>
            <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {t.features.items.map((f, i) => (
                <FeatureTile key={f.title} icon={FEATURE_ICONS[i]} title={f.title} text={f.text} index={i} />
              ))}
            </ul>
            <Numbers />
          </div>
        </section>

        {/* how it works */}
        <section id="como-funciona" className="mx-auto max-w-page px-4 py-20 md:px-6">
          <SectionLink href={`${REPO_URL}#production-docker`}>{t.how.link}</SectionLink>
          <h2 className="mt-4 text-heading-lg">{t.how.title}</h2>
          <ol className="mt-10 grid gap-5 md:grid-cols-3">
            {t.how.steps.map((s, i) => (
              <StepCard key={s.title} step={i + 1} title={s.title} text={s.text} index={i} />
            ))}
          </ol>
          <div className="mt-5 rounded-card border border-border-2 bg-surface p-5">
            <p className="mb-2 text-caption uppercase tracking-wide text-muted">{t.how.stack_label}</p>
            <p className="text-body-sm text-frost">{t.how.stack}</p>
          </div>
        </section>

        {/* cloud + waitlist */}
        <section id="cloud">
          <div className="mx-auto grid max-w-page gap-10 px-4 py-20 md:grid-cols-2 md:px-6">
            <div>
              <p className="mb-4 inline-flex items-center gap-2 rounded-field border border-border-2 bg-canvas px-3 py-1 text-caption text-frost">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" /> {t.cloud.badge}
              </p>
              <h2 className="text-heading-lg">{t.cloud.title}</h2>
              <p className="mt-4 max-w-xl text-body text-frost">{t.cloud.lead}</p>
              <ul className="mt-5 space-y-2 text-body-sm">
                {t.cloud.perks.map((p) => (
                  <li key={p} className="flex gap-2">
                    <span className="text-accent">✓</span>
                    <span className="text-frost">{p}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-card border border-border-2 bg-surface p-5">
              <h3 className="mb-4 text-subheading">{t.cloud.form.title}</h3>
              <WaitlistForm />
            </div>
          </div>
        </section>

        <FinalCta />
      </main>

      <footer className="border-t border-border-2">
        <div className="mx-auto flex max-w-page flex-wrap items-center gap-x-6 gap-y-2 px-4 py-6 text-caption text-muted md:px-6">
          <span>© {new Date().getFullYear()} termhub · MIT</span>
          <a href={REPO_URL} className="hover-tint px-1.5 py-0.5 hover:text-frost">GitHub</a>
          <a href={`${REPO_URL}/blob/main/README.md`} className="hover-tint px-1.5 py-0.5 hover:text-frost">{t.footer.docs}</a>
          <a href={COFFEE_URL} className="hover-tint px-1.5 py-0.5 hover:text-frost">{t.footer.coffee}</a>
          {ANALYTICS_ENABLED && (
            <button type="button" onClick={onOpenCookies} className="hover-tint px-1.5 py-0.5 hover:text-frost">
              {t.footer.cookies}
            </button>
          )}
          <span className="ml-auto">{t.footer.made}</span>
        </div>
      </footer>
    </div>
  );
}

export function App() {
  const [lang, setLangState] = useState<Lang>(detectLang);
  // open until the visitor answers; the footer "Cookies" button reopens it to change the choice
  const [cookiesOpen, setCookiesOpen] = useState(() => ANALYTICS_ENABLED && readConsent() === null);
  const setLang = (l: Lang) => {
    if (l !== lang) {
      setAnalyticsLang(l);
      track('lang_switch', { lang: l });
    }
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
  // analytics starts only with a stored "granted"; withdrawing it stops collection at once,
  // without waiting for the next page load
  useEffect(() => {
    if (readConsent() === 'granted') initAnalytics(lang);
    return subscribeConsent((consent) => {
      setCookiesOpen(false);
      if (consent === 'granted') initAnalytics(lang);
      else disableAnalytics();
    });
  }, [lang]);
  return (
    <LangContext.Provider value={{ lang, t: DICT[lang], setLang }}>
      <Page onOpenCookies={() => setCookiesOpen(true)} />
      {ANALYTICS_ENABLED && <CookieBanner open={cookiesOpen} />}
    </LangContext.Provider>
  );
}
