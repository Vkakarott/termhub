import { type ReactNode } from 'react';
import { HeroCarousel } from './HeroCarousel';
import { useLang, type Dict } from './i18n';
import { APP_URL, Chevron, REPO_URL, Site, SiteFooter, SiteHeader, trackCta } from './Site';
import { useReveal } from './useReveal';
import { WaitlistForm } from './WaitlistForm';

const FEATURE_ICONS = ['▮_', '⌂', '✦', '▦', '◔', '◫'];

/** Tiles fade up in sequence, capped so the last one never feels late. */
const revealDelay = (index: number) => ({ transitionDelay: `${Math.min(index * 60, 300)}ms` });

function SectionLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className="section-link">
      {children} <Chevron />
    </a>
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

/** Any CLI agent works because a tab is a real terminal: names only, no third-party logos. */
function Agents() {
  const { t } = useLang();
  const ref = useReveal<HTMLDivElement>();
  return (
    <section id="agentes" className="mx-auto max-w-page px-4 py-20 md:px-6">
      <h2 className="text-heading-lg">{t.agents.title}</h2>
      <p className="mt-4 max-w-2xl text-subheading text-frost">{t.agents.lead}</p>
      <div ref={ref} className="reveal mt-10">
        <ul className="flex flex-wrap gap-3">
          {t.agents.items.map((name) => (
            <li key={name} className="rounded-field border border-border-2 bg-surface px-4 py-2 font-mono text-body-sm text-white hover:border-border/40">
              {name}
            </li>
          ))}
          <li className="rounded-field border border-dashed border-border-2 px-4 py-2 font-mono text-body-sm text-accent">+ {t.agents.any}</li>
        </ul>
        <p className="mt-6 max-w-2xl text-body-sm text-frost">{t.agents.note}</p>
      </div>
    </section>
  );
}

type CompareCell = 'yes' | 'no' | 'partial';
const COMPARE_MARK: Record<CompareCell, string> = { yes: '✓', no: '—', partial: '◐' };
const COMPARE_TONE: Record<CompareCell, string> = { yes: 'text-accent', no: 'text-muted', partial: 'text-frost' };

function Compare() {
  const { t } = useLang();
  const ref = useReveal<HTMLDivElement>();
  return (
    <section id="comparar" className="mx-auto max-w-page px-4 py-20 md:px-6">
      <h2 className="text-heading-lg">{t.compare.title}</h2>
      <p className="mt-4 max-w-2xl text-subheading text-frost">{t.compare.lead}</p>
      {/* `relative` keeps the cells' absolutely-positioned sr-only spans inside this scroll
          container: without it they escape to the document, which then gets as wide as the
          table and iOS Safari zooms the whole page out to fit it. */}
      <div ref={ref} className="reveal relative mt-10 overflow-x-auto rounded-card border border-border-2 bg-surface">
        <table className="w-full min-w-[760px] border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-border-2">
              <th scope="col" className="p-4 text-left font-normal text-muted" />
              {t.compare.columns.map((c, i) => (
                <th key={c.name} scope="col" className={`p-4 text-center align-bottom ${i === 0 ? 'text-white' : 'font-normal text-frost'}`}>
                  <span className="block">{c.name}</span>
                  {c.hint && <span className="block text-caption text-muted">{c.hint}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {t.compare.rows.map((r) => (
              <tr key={r.label} className="border-b border-border-2 last:border-b-0">
                <th scope="row" className="p-4 text-left font-normal text-frost">{r.label}</th>
                {r.cells.map((cell, i) => (
                  <td key={i} className={`p-4 text-center ${i === 0 ? 'bg-canvas/40' : ''}`}>
                    <span className={`text-body ${COMPARE_TONE[cell as CompareCell]}`} aria-hidden="true">{COMPARE_MARK[cell as CompareCell]}</span>
                    <span className="sr-only">{t.compare.legend[cell as CompareCell]}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-4 text-caption text-muted">
        <span className="text-accent">✓</span> {t.compare.legend.yes} · <span className="text-frost">◐</span> {t.compare.legend.partial} · <span>—</span> {t.compare.legend.no}. {t.compare.note}
      </p>
    </section>
  );
}

/** Native <details> keeps the FAQ keyboard-accessible; the FAQPage JSON-LD in index.html mirrors the pt copy. */
function Faq() {
  const { t } = useLang();
  const ref = useReveal<HTMLDivElement>();
  return (
    <section id="faq" className="mx-auto max-w-page px-4 py-20 md:px-6">
      <h2 className="text-heading-lg">{t.faq.title}</h2>
      <div ref={ref} className="reveal mt-10 grid gap-3 md:max-w-3xl">
        {t.faq.items.map((item) => (
          <details key={item.q} className="group rounded-card border border-border-2 bg-surface open:border-border/40">
            <summary className="hover-tint flex cursor-pointer list-none items-center justify-between gap-4 rounded-card p-5 text-body text-white [&::-webkit-details-marker]:hidden">
              {item.q}
              <span aria-hidden="true" className="text-muted transition-transform group-open:rotate-90">›</span>
            </summary>
            <p className="px-5 pb-5 text-body-sm text-frost">{item.a}</p>
          </details>
        ))}
      </div>
    </section>
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

function Page() {
  const { t } = useLang();
  return (
    <div className="min-h-full">
      <SiteHeader
        nav={
          <>
            <a href="#recursos" className="nav-link">{t.nav.features}</a>
            <a href="#agentes" className="nav-link">{t.nav.agents}</a>
            <a href="#como-funciona" className="nav-link">{t.nav.how}</a>
            <a href="#comparar" className="nav-link hidden lg:inline-flex">{t.nav.compare}</a>
            <a href="#cloud" className="nav-link">{t.nav.cloud}</a>
            <a href="#faq" className="nav-link hidden lg:inline-flex">{t.nav.faq}</a>
            <a href={REPO_URL} className="nav-link hidden lg:inline-flex">{t.nav.github}</a>
          </>
        }
      />

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

        <Agents />

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

        <Compare />

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

        <Faq />

        <FinalCta />
      </main>

      <SiteFooter />
    </div>
  );
}

const meta = (t: Dict) => t.meta;

export function App() {
  return (
    <Site meta={meta}>
      <Page />
    </Site>
  );
}
