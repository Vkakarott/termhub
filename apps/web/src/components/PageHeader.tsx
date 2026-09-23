import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export interface PageHeaderTab {
  to: string;
  label: string;
  /** match the address exactly (a tab whose address is a prefix of its siblings', like `/`) */
  end?: boolean;
  /** a small count after the label (the project's open tasks) */
  badge?: number;
}

export interface PageHeaderProps {
  title: string;
  /** short context next to the title, truncated; a long explanation goes at the top of the content instead */
  subtitle?: string;
  tabs?: PageHeaderTab[];
  /** content between the tabs and the actions (the office's Cidade › máquina › sala trail) */
  extra?: ReactNode;
  /** right-aligned buttons ("+ máquina", "Convidar") */
  actions?: ReactNode;
}

/**
 * The one header every page inside the sidebar layout uses (spec 2026-09-23 app chrome §6). It never
 * clips its overflow: popovers anchored in the actions (PublishControl) hang below the bar.
 */
export function PageHeader({ title, subtitle, tabs, extra, actions }: PageHeaderProps) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-bg-2 px-4">
      <h1 className="min-w-0 shrink truncate text-sm font-semibold" title={title}>
        {title}
      </h1>
      {subtitle && (
        <span className="min-w-0 truncate text-xs text-fg-muted" title={subtitle}>
          {subtitle}
        </span>
      )}
      {tabs && tabs.length > 0 && (
        <nav aria-label={`Seções de ${title}`} className="flex shrink-0 items-center gap-1">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) => `rounded px-3 py-1 text-sm ${isActive ? 'bg-accent/15 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
            >
              {t.label}
              {!!t.badge && <span className="ml-1 text-[10px] text-fg-dim">{t.badge}</span>}
            </NavLink>
          ))}
        </nav>
      )}
      {extra && <div className="flex min-w-0 items-center text-xs text-fg-muted">{extra}</div>}
      {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A page made of the shared header and a scrolling, padded body. */
export function PageFrame({ children, ...header }: PageHeaderProps & { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <PageHeader {...header} />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">{children}</div>
    </div>
  );
}
