import { useCallback, useEffect, useRef, useState } from 'react';
import { useLang } from './i18n';
import { prefersReducedMotion, useReveal } from './useReveal';

const AUTO_MS = 5000;

/** Desaturated terminal semantics: allowed inside the mocks only, never in the UI. */
const TERM_GREEN = '#6fae7c';
const TERM_AMBER = '#c9a86a';

function TerminalPanel() {
  const { t } = useLang();
  const lines: { color: string; text: string }[] = [
    { color: 'text-muted', text: '# jarvis › meu-app › tab 1' },
    { color: 'text-accent', text: '❯ claude' },
    { color: 'text-muted', text: '✻ Claude Code · /Users/pedro/projetos/meu-app' },
    { color: 'text-muted', text: '' },
    { color: 'text-white', text: `> ${t.mock.prompt}` },
    { color: 'text-muted', text: '  ~/.cache/termhub/paste/paste-…-screenshot.png' },
    { color: '', text: '✓ Read  src/auth/login.ts' },
    { color: '', text: '✓ Edit  src/auth/login.ts' },
    { color: '', text: '● Bash  npm test' },
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border-2 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-muted" />
        <span className="h-2 w-2 rounded-full bg-muted" />
        <span className="h-2 w-2 rounded-full bg-muted" />
        <span className="ml-3 flex gap-1 text-[11px]">
          <span className="rounded-tint bg-border-2 px-2 py-0.5 text-frost">claude</span>
          <span className="rounded-tint px-2 py-0.5 text-muted">server</span>
          <span className="rounded-tint px-2 py-0.5 text-muted">logs</span>
        </span>
        <span className="ml-auto hidden text-caption-sm text-muted sm:block">tmux · UTF-8</span>
      </div>
      <pre className="flex-1 overflow-hidden p-3 font-mono text-[10px] leading-[1.5] md:p-4 md:text-[12px] md:leading-5">
        {lines.map((line, i) => (
          <div
            key={i}
            className={line.color || undefined}
            style={line.color ? undefined : { color: line.text.startsWith('✓') ? TERM_GREEN : TERM_AMBER }}
          >
            {line.text}
          </div>
        ))}
        <div>
          <span className="inline-block h-3 w-[6px] animate-pulse bg-frost align-middle md:h-4 md:w-2" />
        </div>
      </pre>
      <div className="flex items-center gap-2 border-t border-border-2 px-3 py-1 text-[11px] text-muted">
        <span className="rounded-tint bg-border-2 px-1.5 text-frost">{t.mock.status}</span>
        <span className="truncate">{t.mock.hint}</span>
        <span className="ml-auto hidden font-mono sm:block">tmux</span>
      </div>
    </div>
  );
}

function HardwarePanel() {
  const { t } = useLang();
  const hw = t.carousel.hardware;
  return (
    <div className="flex h-full flex-col gap-3 p-3 md:gap-4 md:p-4">
      <div className="grid grid-cols-2 gap-2 md:gap-3">
        {hw.kpis.map((kpi) => (
          <div key={kpi.label} className="rounded-field border border-border-2 bg-canvas p-2 md:p-3">
            <p className="text-[10px] uppercase tracking-wide text-muted">{kpi.label}</p>
            <p className="mt-0.5 text-[12px] font-medium text-white md:text-body-sm">{kpi.value}</p>
            <span className="mt-1.5 block h-[3px] w-full rounded-full bg-border-2">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${kpi.pct}%` }} />
            </span>
          </div>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-field border border-border-2 bg-canvas px-2 py-1.5 font-mono text-[10px] leading-[1.6] md:px-3 md:text-[11px]">
        <div className="flex gap-2 text-muted">
          <span className="flex-1">{hw.procs_head[0]}</span>
          <span className="w-12 text-right">{hw.procs_head[1]}</span>
          <span className="w-14 text-right">{hw.procs_head[2]}</span>
        </div>
        {hw.procs.map((proc) => (
          <div key={proc.name} className="flex gap-2 text-frost">
            <span className="flex-1 truncate">{proc.name}</span>
            <span className="w-12 text-right text-muted">{proc.cpu}</span>
            <span className="w-14 text-right text-muted">{proc.mem}</span>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-muted">{hw.caption}</p>
    </div>
  );
}

function SimulatorPanel() {
  const { t } = useLang();
  const ios = t.carousel.ios;
  return (
    <div className="flex h-full flex-col p-3 md:p-4">
      <div className="flex min-h-0 flex-1 items-center justify-center gap-4 md:gap-6">
        <div className="aspect-[9/19] h-[120px] shrink-0 rounded-[28px] border border-border/60 bg-canvas p-1.5 md:h-[220px] md:p-2">
          <div className="flex h-full flex-col gap-1 overflow-hidden rounded-[22px] bg-surface p-1.5 md:gap-1.5">
            <p className="text-[7px] font-medium text-white md:text-[9px]">{ios.screen_title}</p>
            {ios.rows.map((row) => (
              <div key={row} className="flex items-center rounded-[4px] bg-border-2 px-1 py-0.5 text-[6px] text-frost md:text-[8px]">
                {row}
              </div>
            ))}
            <div className="mt-auto rounded-full border border-accent px-1 py-0.5 text-center text-[6px] text-accent md:text-[8px]">
              {ios.button}
            </div>
          </div>
        </div>
        <ul className="space-y-1.5 text-[11px] text-frost md:space-y-2 md:text-caption">
          {ios.actions.map((action) => (
            <li key={action} className="flex items-center gap-2">
              <span className="h-1 w-1 shrink-0 rounded-full bg-accent" />
              {action}
            </li>
          ))}
        </ul>
      </div>
      <p className="pt-2 text-[10px] text-muted">{ios.caption}</p>
    </div>
  );
}

function KanbanPanel() {
  const { t } = useLang();
  return (
    <div className="grid h-full grid-cols-2 gap-2 p-3 md:grid-cols-4 md:gap-3 md:p-4">
      {t.carousel.kanban.columns.map((column) => (
        <div key={column.title} className="flex min-w-0 flex-col gap-1.5 md:gap-2">
          <p className="text-[10px] uppercase tracking-wide text-muted">{column.title}</p>
          {column.cards.map((card) => (
            <div key={card.text} className="rounded-field border border-border-2 bg-surface p-1.5 text-[11px] text-frost md:p-2 md:text-caption">
              <span className="block truncate">{card.text}</span>
              {card.chip ? (
                <span className="mt-1 inline-block rounded-tint border border-border-2 px-1 font-mono text-[9px] text-accent">{card.chip}</span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const PANELS = [TerminalPanel, HardwarePanel, SimulatorPanel, KanbanPanel];

/** Tab strip + auto-advancing stack of product mocks shown next to the hero copy. */
export function HeroCarousel() {
  const { t } = useLang();
  const tabs = t.carousel.tabs;
  const [active, setActive] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reduced, setReduced] = useState(prefersReducedMotion);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const frameRef = useReveal<HTMLDivElement>();

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // a hidden tab keeps its timer stopped, so the panel does not race ahead in a background tab
  useEffect(() => {
    const onVisibility = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (reduced || paused) return;
    const id = window.setTimeout(() => setActive((i) => (i + 1) % tabs.length), AUTO_MS);
    return () => window.clearTimeout(id);
  }, [active, paused, reduced, tabs.length]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const next = (active + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
      setActive(next);
      tabRefs.current[next]?.focus();
    },
    [active, tabs.length],
  );

  return (
    <div
      className="w-full"
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(document.hidden)}
    >
      <div role="tablist" aria-label={t.carousel.label} onKeyDown={onKeyDown} className="mb-3 flex flex-wrap gap-1">
        {tabs.map((tab, i) => (
          <button
            key={tab}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`hero-tab-${i}`}
            aria-selected={i === active}
            aria-controls={`hero-panel-${i}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={`rounded-tint px-2 py-1 text-body-sm font-medium transition duration-150 ${
              i === active ? 'border-b-2 border-accent text-white' : 'border-b-2 border-transparent text-muted hover:text-frost'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>
      <div
        ref={frameRef}
        className="reveal relative aspect-[16/10] w-full overflow-hidden rounded-card border border-border-2 bg-surface"
      >
        {PANELS.map((Panel, i) => (
          <div
            key={i}
            role="tabpanel"
            id={`hero-panel-${i}`}
            aria-labelledby={`hero-tab-${i}`}
            aria-hidden={i !== active}
            className={`absolute inset-0 ${reduced ? '' : 'transition-opacity duration-300'} ${
              i === active ? 'opacity-100' : 'pointer-events-none opacity-0'
            }`}
          >
            <Panel />
          </div>
        ))}
      </div>
    </div>
  );
}
