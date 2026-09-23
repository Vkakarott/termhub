# App chrome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every signed-in page one shared header (`PageHeader`), turn Configurações into a sidebar that slides over the projects sidebar (entered from the profile row, opening Perfil), reduce the main sidebar's bottom to the daily menus with line icons plus a profile button, and make the collapsed sidebar a useful rail (Favoritos, daily icons, avatar).

**Architecture:** A `PageHeader`/`PageFrame` pair in `components/PageHeader.tsx` replaces each page's hand-made bar. The settings model (`lib/settings-sections.ts`) gains Perfil and Integrações and two groups (Conta, Administração); `SettingsPage` no longer draws a tab row and redirects to `/settings/profile`. The layout's `Chrome` picks the sidebar slot by route: `SettingsSidebar` under `/settings`, `Sidebar` elsewhere, `SidebarRail` (with a `settings` mode) when collapsed. A hook in `lib/settings-nav.ts`, called once in `Layout`, remembers the last location outside settings and handles Esc through the existing Escape-layer stack in `components/Modal.tsx`.

**Tech Stack:** React 18 + react-router-dom 7 + Tailwind 3 + vitest 3 / Testing Library (jsdom), with `lucide-react` added for icons.

**Spec:** `docs/superpowers/specs/2026-09-23-app-chrome-design.md`

## Global Constraints

- Work in `/home/pedrogoiania/termhub-wt-chrome` (branch `feat/app-chrome`). Every command below runs from that directory.
- The host has no Node. Every npm/node command runs as `docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c '<cmd>'` and is followed by `rm -rf .npm` (the container leaves that cache behind).
- `node_modules` is not installed. Before Task 1 run once: `npm ci && npm run build:packages && npm run prisma:generate` (the package builds and client generation CLAUDE.md's verification needs).
- Web tests run with `CI=1` **after** `npm run build:city -w @termhub/web`, so the public-bundle guard (`apps/web/src/city/bundle.test.ts`) runs instead of skipping. The gate before every commit is: `npm run typecheck -w @termhub/web && npm run build:city -w @termhub/web && CI=1 npm test -w @termhub/web`.
- Workspaces are addressed by package name (`-w @termhub/web`), never by path.
- Code, comments, identifiers and commit messages are in English; commit subjects imperative, area-prefixed (`Web: …`), ≤ 72 chars. **UI copy stays in pt-BR** exactly as written in this plan.
- The public city bundle rule: `apps/web/src/city/**` imports only `office/**` and `lib/types.ts`. Never import `lucide-react` (or anything this plan adds) from `city/**` or `office/**`.
- Icons (spec §2): `lucide-react`, `Building2` Escritório, `MessageSquare` Chat, `Monitor` Máquinas, `Settings` engrenagem, `User` Perfil, `Map` Minha cidade, `Plug` Integrações, `KeyRound` Tokens de API, `Users` Usuários, `Shield` Roles, `ListChecks` Permissões, `Folder` Arquivos, `LogOut` Sair, `ChevronsLeft`/`ChevronsRight` recolher/expandir, `ArrowLeft` voltar. Size 16 in the open sidebar, 18 in the rail; colour `currentColor` (lucide's default); always `aria-hidden="true"`. Import `Map` and `User` under aliases (`Map as MapIcon`, `User as UserIcon`) so they never shadow the global `Map` or the `User` type.
- `PageHeader` (spec §6): one bar, `h-11`, `bg-bg-2`, `border-b border-line`, `px-4`, title `text-sm font-semibold`, subtitle `text-xs text-fg-muted` (truncated), tabs as `NavLink`s after the title in Home's current style, actions right-aligned. No `overflow-hidden` on it: `PublishControl`'s popover hangs below the project header.
- The collapsed flag stays in `localStorage` under `termhub:sidebar-collapsed`; "last location outside settings" lives in memory in the layout only.
- Slide: 150 ms `transform`, disabled under `prefers-reduced-motion: reduce`.
- Never touch production containers (`termhub-*`, `proxy-*`, any `*-app-*`), `deploy/blue-green.sh`, or `/mnt/hd2tb/projetos/termhub`. Do not push, open PRs or merge.
- Every commit message ends with a blank line and `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

- **An old `/integrations` link clicked from inside the app:** it redirects to `/settings/integrations`; the back button/Esc must return to the page the link was clicked on, not to `/integrations` (which would bounce straight back into settings). → Task 4, `settings-nav.test.tsx` "does not remember the old /integrations address".
- **Esc while a dialog is open over a settings section (Convidar usuário, Nova integração):** Esc closes only the dialog; a second Esc leaves settings. → Task 4, "lets an open dialog take Esc first".
- **Esc inside the Permissões role `<select>` or any text field in settings:** stays in settings. → Task 4, "leaves Esc to a text field or a select".
- **A bookmarked `/settings/users` opened by an account without `users`, or a mistyped section:** lands on Perfil (URL included), never on a blank page. → Task 3, `SettingsPage.test.tsx` "a section this role cannot see lands on Perfil" and "an unknown section lands on Perfil".
- **Favoritos holding archived or deleted projects, and names with emoji/accents/spaces:** the rail shows only live favourites in Favoritos order, and initials never split an emoji or show blank. → Task 6, `favoriteProjects` and `projectInitials` tests.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/components/PageHeader.tsx` (new) | `PageHeader` bar and `PageFrame` (header + scrolling body). |
| `apps/web/src/components/Avatar.tsx` (new) | The user's picture or initial disc (profile row, rail, Perfil). |
| `apps/web/src/components/ProfileView.tsx` (new) | Configurações → Perfil: identity, Ver como…, cookies, Sair. |
| `apps/web/src/components/IntegrationsView.tsx` (moved from `pages/IntegrationsPage.tsx`) | The Integrações settings section. |
| `apps/web/src/lib/settings-sections.ts` | Section catalogue: keys, labels, resources, groups, default. |
| `apps/web/src/pages/SettingsPage.tsx` | Picks the section; redirects to Perfil; each section under `PageFrame`. |
| `apps/web/src/App.tsx` | `AppRoutes` (exported for tests) + `/integrations` redirect. |
| `apps/web/src/lib/settings-nav.ts` (new) | `isSettingsPath`, `keepsEscape`, `useSettingsExit` (last location + Esc). |
| `apps/web/src/components/Modal.tsx` | `useEscapeLayer` passes the `KeyboardEvent` to its callback. |
| `apps/web/src/components/settings-icons.ts` (new) | Section → lucide icon map, shared by sidebar and rail. |
| `apps/web/src/components/SettingsSidebar.tsx` (new) | Settings sidebar: back, collapse, grouped section links. |
| `apps/web/src/components/Layout.tsx` | `Chrome` chooses the sidebar slot by route and collapsed flag. |
| `apps/web/src/index.css` | `chrome-slide-in` animation + reduced-motion override. |
| `apps/web/src/components/MainNav.tsx` (new) | Escritório/Chat/Máquinas, `list` and `rail` variants. |
| `apps/web/src/components/ProfileButton.tsx` (new) | Profile row / rail avatar → `/settings/profile`. |
| `apps/web/src/components/Sidebar.tsx` | Bottom becomes `MainNav` + `ProfileButton`; removals. |
| `apps/web/src/lib/project-initials.ts` (new) | Two-letter initials for rail squares. |
| `apps/web/src/lib/project-groups-model.ts` | `favoriteProjects` helper. |
| `apps/web/src/components/SidebarRail.tsx` (new) | The 48 px rail, `main` and `settings` modes. |
| `apps/web/src/pages/{MachinesPage,HomePage,OfficePage,ProjectPage}.tsx`, `components/MyCityView.tsx` | Adopt `PageHeader`/`PageFrame`; drop their own title bars / `h1`s. |

---

### Task 1: lucide-react and the shared page header

**Files:**
- Modify: `apps/web/package.json`, `package-lock.json` (via `npm install`)
- Create: `apps/web/src/components/PageHeader.tsx`
- Test: `apps/web/src/components/PageHeader.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface PageHeaderTab { to: string; label: string; end?: boolean; badge?: number }
  export interface PageHeaderProps { title: string; subtitle?: string; tabs?: PageHeaderTab[]; extra?: ReactNode; actions?: ReactNode }
  export function PageHeader(props: PageHeaderProps): JSX.Element   // <header> with the title as the page's only <h1>
  export function PageFrame(props: PageHeaderProps & { children: ReactNode }): JSX.Element // header + `min-h-0 flex-1 overflow-y-auto p-6` body
  ```
  Tabs render in `<nav aria-label={`Seções de ${title}`}>`. `lucide-react` is a dependency of `@termhub/web`.

- [ ] **Step 1: Install the workspace (once)**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm ci && npm run build:packages && npm run prisma:generate'; rm -rf .npm
```
Expected: exits 0; `node_modules/` exists at the root.

- [ ] **Step 2: Add lucide-react**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm install lucide-react -w @termhub/web'; rm -rf .npm
git diff --stat
grep -n '"node_modules/lucide-react"' package-lock.json
```
Expected: `git diff --stat` lists `apps/web/package.json` and `package-lock.json`; the grep prints one line. `apps/web/package.json` now has `"lucide-react": "^<version>"` under `dependencies`.

- [ ] **Step 3: Write the failing test**

Create `apps/web/src/components/PageHeader.test.tsx`:
```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { PageFrame, PageHeader } from './PageHeader';

afterEach(cleanup);

describe('PageHeader', () => {
  it('renders the title as the page heading, with a truncated subtitle and no tab strip', () => {
    render(
      <MemoryRouter>
        <PageHeader title="Máquinas" subtitle="3 máquinas" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Máquinas' })).toBeInTheDocument();
    expect(screen.getByText('3 máquinas')).toHaveClass('truncate', 'text-xs', 'text-fg-muted');
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('renders tabs as links after the title, marking the current one', () => {
    render(
      <MemoryRouter initialEntries={['/ai']}>
        <PageHeader
          title="Início"
          tabs={[
            { to: '/', label: 'Projetos', end: true },
            { to: '/ai', label: 'Contas de IA', end: true },
          ]}
        />
      </MemoryRouter>,
    );
    const nav = screen.getByRole('navigation', { name: 'Seções de Início' });
    expect(within(nav).getByRole('link', { name: 'Projetos' })).toHaveAttribute('href', '/');
    expect(within(nav).getByRole('link', { name: 'Projetos' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('link', { name: 'Contas de IA' })).toHaveAttribute('aria-current', 'page');
  });

  it('shows a tab badge after its label', () => {
    render(
      <MemoryRouter>
        <PageHeader title="alpha" tabs={[{ to: '/projects/p1/tasks', label: 'Tarefas', badge: 3 }]} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /Tarefas/ }).textContent).toBe('Tarefas3');
  });

  it('puts the extra content after the title and the actions at the right end', () => {
    render(
      <MemoryRouter>
        <PageHeader title="Escritório" extra={<nav aria-label="Trilha">Cidade</nav>} actions={<button>modo foco</button>} />
      </MemoryRouter>,
    );
    const header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    expect(within(header).getByLabelText('Trilha')).toBeInTheDocument();
    expect(within(header).getByRole('button', { name: 'modo foco' }).parentElement).toHaveClass('ml-auto');
  });
});

describe('PageFrame', () => {
  it('puts the header above a scrolling body', () => {
    render(
      <MemoryRouter>
        <PageFrame title="Máquinas" actions={<button>+ máquina</button>}>
          <p>corpo</p>
        </PageFrame>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: '+ máquina' }).closest('header')).not.toBeNull();
    expect(screen.getByText('corpo').parentElement).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'p-6');
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/PageHeader.test.tsx'; rm -rf .npm
```
Expected: FAIL — `Failed to resolve import "./PageHeader"`.

- [ ] **Step 5: Write the implementation**

Create `apps/web/src/components/PageHeader.tsx`:
```tsx
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
```

- [ ] **Step 6: Run the test to verify it passes**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/PageHeader.test.tsx'; rm -rf .npm
```
Expected: PASS (5 tests).

- [ ] **Step 7: Run the web gate**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/web && npm run build:city -w @termhub/web && CI=1 npm test -w @termhub/web'; rm -rf .npm
```
Expected: typecheck clean; all web tests pass, including `src/city/bundle.test.ts` (not skipped).

- [ ] **Step 8: Commit**

```bash
git add apps/web/package.json package-lock.json apps/web/src/components/PageHeader.tsx apps/web/src/components/PageHeader.test.tsx
git commit -m "Web: add lucide-react and the shared page header

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Settings catalogue with Perfil and Integrações, and the Perfil section

**Files:**
- Modify: `apps/web/src/lib/settings-sections.ts` (whole file)
- Modify: `apps/web/src/lib/settings-sections.test.ts` (whole file)
- Create: `apps/web/src/components/Avatar.tsx`
- Create: `apps/web/src/components/ProfileView.tsx`
- Test: `apps/web/src/components/ProfileView.test.tsx`
- Modify: `apps/web/src/components/ViewAsSwitch.tsx:40,46`
- Move: `apps/web/src/pages/IntegrationsPage.tsx` → `apps/web/src/components/IntegrationsView.tsx`
- Modify: `apps/web/src/pages/SettingsPage.tsx:1-48`, `apps/web/src/pages/SettingsPage.test.tsx`
- Modify: `apps/web/src/App.tsx:13,55`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  // lib/settings-sections.ts
  export type SettingsSection = 'profile' | 'city' | 'integrations' | 'api-tokens' | 'users' | 'roles' | 'permissions' | 'uploads';
  export type SettingsGroupId = 'account' | 'admin';
  export interface SettingsSectionInfo { key: SettingsSection; label: string; resource: string | null; group: SettingsGroupId }
  export const SETTINGS_SECTIONS: SettingsSectionInfo[];
  export const DEFAULT_SETTINGS_SECTION: SettingsSection; // 'profile'
  export function visibleSettingsSections(can: (resource: string) => boolean): SettingsSectionInfo[];
  export function settingsGroups(can: (resource: string) => boolean): { id: SettingsGroupId; label: string; sections: SettingsSectionInfo[] }[];
  export function canSeeSettings(can: (resource: string) => boolean): boolean; // kept only until Task 5 deletes it
  // components/Avatar.tsx
  export function Avatar(props: { user: Pick<User, 'name' | 'avatar_url'> | null; size: number }): JSX.Element;
  // components/ProfileView.tsx
  export function ProfileView(): JSX.Element;
  // components/IntegrationsView.tsx
  export function IntegrationsView(): JSX.Element;
  ```

- [ ] **Step 1: Write the failing catalogue test**

Replace `apps/web/src/lib/settings-sections.test.ts` with:
```ts
import { describe, expect, it } from 'vitest';
import { canSeeSettings, DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, settingsGroups, visibleSettingsSections } from './settings-sections';

const keysOf = (groups: ReturnType<typeof settingsGroups>) => groups.map((g) => [g.label, g.sections.map((s) => s.key)]);

describe('settings sections', () => {
  it('lists Conta, then Administração, in the settings sidebar order', () => {
    expect(SETTINGS_SECTIONS.map((s) => `${s.group}:${s.key}`)).toEqual([
      'account:profile',
      'account:city',
      'account:integrations',
      'account:api-tokens',
      'admin:users',
      'admin:roles',
      'admin:permissions',
      'admin:uploads',
    ]);
  });

  it('opens on Perfil, which every signed-in user sees', () => {
    expect(DEFAULT_SETTINGS_SECTION).toBe('profile');
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'profile')).toEqual({ key: 'profile', label: 'Perfil', resource: null, group: 'account' });
    expect(visibleSettingsSections(() => false).map((s) => s.key)).toEqual(['profile', 'city']);
    expect(visibleSettingsSections(() => true)[0]?.key).toBe('profile');
  });

  it('gates Integrações and Tokens de API by their resource', () => {
    expect(SETTINGS_SECTIONS.find((s) => s.key === 'integrations')).toEqual({ key: 'integrations', label: 'Integrações', resource: 'integrations', group: 'account' });
    expect(visibleSettingsSections((r) => r === 'api_tokens').map((s) => s.key)).toEqual(['profile', 'city', 'api-tokens']);
    expect(visibleSettingsSections((r) => r === 'integrations').map((s) => s.key)).toEqual(['profile', 'city', 'integrations']);
  });

  it('keeps the admin sections under their current resources', () => {
    expect(visibleSettingsSections((r) => r === 'roles').map((s) => s.key)).toEqual(['profile', 'city', 'roles', 'permissions']);
    expect(visibleSettingsSections((r) => r === 'users').map((s) => s.key)).toEqual(['profile', 'city', 'users']);
  });

  it('leaves Administração out when nothing in it is visible', () => {
    expect(keysOf(settingsGroups(() => false))).toEqual([['Conta', ['profile', 'city']]]);
    expect(keysOf(settingsGroups((r) => r === 'uploads'))).toEqual([
      ['Conta', ['profile', 'city']],
      ['Administração', ['uploads']],
    ]);
  });

  it('always shows Configurações', () => {
    expect(canSeeSettings(() => false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/lib/settings-sections.test.ts'; rm -rf .npm
```
Expected: FAIL — `DEFAULT_SETTINGS_SECTION`/`settingsGroups` are not exported, the section list differs.

- [ ] **Step 3: Rewrite the catalogue**

Replace `apps/web/src/lib/settings-sections.ts` with:
```ts
/**
 * Configurações' sections in the settings sidebar's order, the resource that unlocks each and the
 * heading each sits under (spec 2026-09-23 app chrome §4). `resource: null` is a section every
 * signed-in user sees; Perfil is one, so `/settings` always has somewhere to land.
 */
export type SettingsSection = 'profile' | 'city' | 'integrations' | 'api-tokens' | 'users' | 'roles' | 'permissions' | 'uploads';
export type SettingsGroupId = 'account' | 'admin';

export interface SettingsSectionInfo {
  key: SettingsSection;
  label: string;
  resource: string | null;
  group: SettingsGroupId;
}

export const SETTINGS_SECTIONS: SettingsSectionInfo[] = [
  { key: 'profile', label: 'Perfil', resource: null, group: 'account' },
  { key: 'city', label: 'Minha cidade', resource: null, group: 'account' },
  { key: 'integrations', label: 'Integrações', resource: 'integrations', group: 'account' },
  { key: 'api-tokens', label: 'Tokens de API', resource: 'api_tokens', group: 'account' },
  { key: 'users', label: 'Usuários', resource: 'users', group: 'admin' },
  { key: 'roles', label: 'Roles', resource: 'roles', group: 'admin' },
  { key: 'permissions', label: 'Permissões', resource: 'roles', group: 'admin' },
  { key: 'uploads', label: 'Arquivos', resource: 'uploads', group: 'admin' },
];

/** where `/settings` lands, and where an address this role cannot open falls back to */
export const DEFAULT_SETTINGS_SECTION: SettingsSection = 'profile';

const GROUP_LABEL: Record<SettingsGroupId, string> = { account: 'Conta', admin: 'Administração' };

export function visibleSettingsSections(can: (resource: string) => boolean): SettingsSectionInfo[] {
  return SETTINGS_SECTIONS.filter((s) => s.resource === null || can(s.resource));
}

/** The visible sections under their headings; a heading with nothing visible under it is left out. */
export function settingsGroups(can: (resource: string) => boolean): { id: SettingsGroupId; label: string; sections: SettingsSectionInfo[] }[] {
  const visible = visibleSettingsSections(can);
  return (Object.keys(GROUP_LABEL) as SettingsGroupId[])
    .map((id) => ({ id, label: GROUP_LABEL[id], sections: visible.filter((s) => s.group === id) }))
    .filter((g) => g.sections.length > 0);
}

export function canSeeSettings(can: (resource: string) => boolean): boolean {
  return visibleSettingsSections(can).length > 0;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/lib/settings-sections.test.ts'; rm -rf .npm
```
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing ProfileView test**

Create `apps/web/src/components/ProfileView.test.tsx`:
```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../lib/types';

// vi.mock factories are hoisted: everything they touch comes through vi.hoisted().
const { authState, analytics, openCookieBanner } = vi.hoisted(() => ({
  authState: {
    current: {
      user: null as User | null,
      logout: vi.fn(async () => {}),
      viewAs: null,
      setViewAs: vi.fn(async () => {}),
    },
  },
  analytics: { enabled: false },
  openCookieBanner: vi.fn(),
}));

vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
vi.mock('../lib/api', () => ({ api: { users: { list: () => new Promise(() => {}) } } }));
vi.mock('../lib/analytics', () => ({
  get ANALYTICS_ENABLED() {
    return analytics.enabled;
  },
}));
vi.mock('./AnalyticsGate', () => ({ openCookieBanner }));

import { ProfileView } from './ProfileView';

const user = (isAdmin: boolean): User => ({
  id: 'u1',
  email: 'pedro@example.com',
  name: 'Pedro',
  avatar_url: null,
  role: 'owner',
  role_info: { id: 'r1', name: isAdmin ? 'ADMIN' : 'AUTHENTICATED', label: isAdmin ? 'Admin' : 'Usuário', is_admin: isAdmin },
  permissions: [],
  has_password: false,
  has_google: true,
  invited_at: null,
  last_login_at: null,
  nickname: null,
});

function mount() {
  return render(
    <MemoryRouter initialEntries={['/settings/profile']}>
      <Routes>
        <Route path="/settings/profile" element={<ProfileView />} />
        <Route path="/login" element={<p>login-page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authState.current = { ...authState.current, user: user(false) };
  analytics.enabled = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProfileView', () => {
  it('shows who is signed in', () => {
    mount();
    expect(screen.getByText('Pedro')).toBeInTheDocument();
    expect(screen.getByText('pedro@example.com')).toBeInTheDocument();
  });

  it('offers Ver como… to admins only', () => {
    mount();
    expect(screen.queryByRole('button', { name: /Ver como/ })).toBeNull();
    cleanup();
    authState.current = { ...authState.current, user: user(true) };
    mount();
    expect(screen.getByRole('button', { name: /Ver como/ })).toBeInTheDocument();
  });

  it('Sair logs out and goes to the login page', async () => {
    mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sair' }));
    });
    expect(authState.current.logout).toHaveBeenCalledTimes(1);
    expect(screen.getByText('login-page')).toBeInTheDocument();
  });

  it('offers the cookie preferences only when analytics is on', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Preferências de cookies' })).toBeNull();
    cleanup();
    analytics.enabled = true;
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Preferências de cookies' }));
    expect(openCookieBanner).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/ProfileView.test.tsx'; rm -rf .npm
```
Expected: FAIL — `Failed to resolve import "./ProfileView"`.

- [ ] **Step 7: Create Avatar and ProfileView; restyle ViewAsSwitch for a page**

Create `apps/web/src/components/Avatar.tsx`:
```tsx
import type { User } from '../lib/types';

/** The user's picture, or their initial on a plain disc when they have none. */
export function Avatar({ user, size }: { user: Pick<User, 'name' | 'avatar_url'> | null; size: number }) {
  const box = { width: size, height: size };
  if (user?.avatar_url) return <img src={user.avatar_url} alt="" style={box} className="shrink-0 rounded-full" referrerPolicy="no-referrer" />;
  return (
    <span aria-hidden="true" style={{ ...box, fontSize: Math.round(size * 0.45) }} className="flex shrink-0 items-center justify-center rounded-full bg-bg-4 font-semibold">
      {user?.name?.[0]?.toUpperCase() ?? '?'}
    </span>
  );
}
```

Create `apps/web/src/components/ProfileView.tsx`:
```tsx
import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ANALYTICS_ENABLED } from '../lib/analytics';
import { useAuth } from '../lib/auth';
import { openCookieBanner } from './AnalyticsGate';
import { Avatar } from './Avatar';
import { ViewAsSwitch } from './ViewAsSwitch';

/**
 * Configurações → Perfil (spec 2026-09-23 app chrome §4.1): who is signed in, and what used to sit in
 * the sidebar's profile row — the admin's "Ver como…" (ViewAsSwitch renders nothing for others), the
 * cookie choice when analytics is on, and Sair.
 */
export function ProfileView() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="max-w-2xl space-y-4">
      <section aria-label="Conta" className="flex items-center gap-3 rounded-lg border border-line bg-bg-2 p-4">
        <Avatar user={user} size={40} />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{user?.name}</p>
          <p className="truncate text-xs text-fg-muted">{user?.email}</p>
        </div>
      </section>
      <ViewAsSwitch />
      <div className="flex flex-wrap gap-2">
        {ANALYTICS_ENABLED && (
          <button type="button" className="btn-ghost" onClick={openCookieBanner}>
            Preferências de cookies
          </button>
        )}
        <button type="button" className="btn-ghost text-danger" onClick={() => void logout().then(() => navigate('/login'))}>
          <LogOut size={16} aria-hidden="true" />
          Sair
        </button>
      </div>
    </div>
  );
}
```

In `apps/web/src/components/ViewAsSwitch.tsx` replace line 40:
```tsx
    <div className={`border-t border-line px-3 py-1.5 ${viewAs ? 'bg-warn/10' : ''}`}>
```
with:
```tsx
    <div className={`rounded-lg border px-3 py-2 ${viewAs ? 'border-warn/40 bg-warn/10' : 'border-line bg-bg-2'}`}>
```
and line 46:
```tsx
        <span className="flex-1 truncate">{label ?? '👁 Ver como…'}</span>
```
with:
```tsx
        <span className="flex-1 truncate">{label ?? 'Ver como…'}</span>
```

- [ ] **Step 8: Run it to verify it passes**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/ProfileView.test.tsx'; rm -rf .npm
```
Expected: PASS (4 tests).

- [ ] **Step 9: Move Integrações into a component**

Run:
```bash
git mv apps/web/src/pages/IntegrationsPage.tsx apps/web/src/components/IntegrationsView.tsx
```
In `apps/web/src/components/IntegrationsView.tsx` replace:
```tsx
import { ConfirmDialog, Modal } from '../components/Modal';
```
with:
```tsx
import { ConfirmDialog, Modal } from './Modal';
```
and replace:
```tsx
export function IntegrationsPage() {
```
with:
```tsx
/** Configurações → Integrações: GitHub, Linear and Jira credentials (was the `/integrations` page). */
export function IntegrationsView() {
```
In `apps/web/src/App.tsx` replace line 13 `import { IntegrationsPage } from './pages/IntegrationsPage';` with `import { IntegrationsView } from './components/IntegrationsView';` and line 55 `<Route path="/integrations" element={<IntegrationsPage />} />` with `<Route path="/integrations" element={<IntegrationsView />} />` (Task 3 turns it into a redirect).

- [ ] **Step 10: Update the SettingsPage test for the new sections (failing)**

In `apps/web/src/pages/SettingsPage.test.tsx`, after the `vi.mock('../components/MyCityView', …)` line add:
```tsx
vi.mock('../components/ProfileView', () => ({ ProfileView: () => <p>profile-view</p> }));
vi.mock('../components/IntegrationsView', () => ({ IntegrationsView: () => <p>integrations-view</p> }));
```
and replace the whole `describe('SettingsPage', …)` block with:
```tsx
describe('SettingsPage', () => {
  it('lands a user without any settings permission on Perfil, with Minha cidade among the tabs', () => {
    authState.current = { can: () => false };
    renderAt('/settings');
    expect(screen.getByText('profile-view')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Minha cidade' }).getAttribute('href')).toBe('/settings/city');
    expect(screen.queryByRole('link', { name: 'Usuários' })).toBeNull();
  });

  it('lands an admin on Perfil too', () => {
    authState.current = { can: () => true };
    renderAt('/settings');
    expect(screen.getByText('profile-view')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Usuários' })).toBeTruthy();
  });

  it('opens Minha cidade from its own address', () => {
    authState.current = { can: () => true };
    renderAt('/settings/city');
    expect(screen.getByText('minha-cidade-view')).toBeTruthy();
  });

  it('opens Integrações as a section', () => {
    authState.current = { can: (r) => r === 'integrations' };
    renderAt('/settings/integrations');
    expect(screen.getByText('integrations-view')).toBeTruthy();
  });
});
```

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/pages/SettingsPage.test.tsx'; rm -rf .npm
```
Expected: FAIL — `profile-view` and `integrations-view` are not rendered (the page has no case for them).

- [ ] **Step 11: Render the new sections in SettingsPage**

In `apps/web/src/pages/SettingsPage.tsx` add after `import { MyCityView } from '../components/MyCityView';`:
```tsx
import { ProfileView } from '../components/ProfileView';
import { IntegrationsView } from '../components/IntegrationsView';
```
and after the line `{current === 'city' && <MyCityView />}` add:
```tsx
        {current === 'profile' && <ProfileView />}
        {current === 'integrations' && <IntegrationsView />}
```

- [ ] **Step 12: Run the web gate**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/web && npm run build:city -w @termhub/web && CI=1 npm test -w @termhub/web'; rm -rf .npm
```
Expected: typecheck clean; every web test passes (SettingsPage 4, settings-sections 6, ProfileView 4).

- [ ] **Step 13: Commit**

```bash
git add -A apps/web/src/lib/settings-sections.ts apps/web/src/lib/settings-sections.test.ts apps/web/src/components/Avatar.tsx apps/web/src/components/ProfileView.tsx apps/web/src/components/ProfileView.test.tsx apps/web/src/components/ViewAsSwitch.tsx apps/web/src/components/IntegrationsView.tsx apps/web/src/pages/IntegrationsPage.tsx apps/web/src/pages/SettingsPage.tsx apps/web/src/pages/SettingsPage.test.tsx apps/web/src/App.tsx
git commit -m "Web: add Perfil and Integrações to the settings sections

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Settings sections under the shared header; /settings and /integrations redirects

**Files:**
- Modify: `apps/web/src/pages/SettingsPage.tsx` (component at lines 1-48; `UsersSection` return at 202-222 and its closing; `RolesSection` return at 402-414 and its closing; `PermissionsSection` header at 538-542)
- Modify: `apps/web/src/components/IntegrationsView.tsx` (return block)
- Modify: `apps/web/src/components/MyCityView.tsx:44-48`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/pages/SettingsPage.test.tsx` (rewrite), `apps/web/src/components/IntegrationsView.test.tsx` (new), `apps/web/src/App.test.tsx` (new)

**Interfaces:**
- Consumes: `PageFrame` (Task 1); `visibleSettingsSections`, `DEFAULT_SETTINGS_SECTION`, `ProfileView`, `IntegrationsView` (Task 2).
- Produces: `export function AppRoutes(): JSX.Element` in `App.tsx` (the `<Routes>` tree, without `BrowserRouter`/providers). `/settings` and any unknown or forbidden `/settings/:section` redirect (replace) to `/settings/profile`; `/integrations` redirects (replace) to `/settings/integrations` and stays a child of the `Layout` route.

- [ ] **Step 1: Rewrite the SettingsPage test (failing)**

Replace `apps/web/src/pages/SettingsPage.test.tsx` with:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { authState } = vi.hoisted(() => ({ authState: { current: { can: (() => true) as (resource: string, action?: string) => boolean } } }));

vi.mock('../lib/auth', () => ({ useAuth: () => authState.current }));
// Each section loads its own data; only which section is picked, and its header, matter here.
vi.mock('../components/MyCityView', () => ({ MyCityView: () => <p>minha-cidade-view</p> }));
vi.mock('../components/ProfileView', () => ({ ProfileView: () => <p>profile-view</p> }));
vi.mock('../components/IntegrationsView', () => ({ IntegrationsView: () => <p>integrations-view</p> }));
vi.mock('../components/UploadsView', () => ({ UploadsView: () => null }));
vi.mock('../components/ApiTokensView', () => ({ ApiTokensView: () => null }));
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: {
    users: { list: () => new Promise(() => {}), access: () => new Promise(() => {}) },
    roles: { list: () => new Promise(() => {}) },
  },
}));

import { SettingsPage } from './SettingsPage';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/settings/:section" element={<SettingsPage />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

const where = () => screen.getByTestId('where').textContent;
const titles = () => screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent);

afterEach(() => {
  cleanup();
});

describe('SettingsPage', () => {
  it('opens /settings on Perfil, for an admin too', () => {
    authState.current = { can: () => true };
    renderAt('/settings');
    expect(where()).toBe('/settings/profile');
    expect(screen.getByText('profile-view')).toBeTruthy();
    expect(titles()).toEqual(['Perfil']);
  });

  it('a section this role cannot see lands on Perfil', () => {
    authState.current = { can: () => false };
    renderAt('/settings/users');
    expect(where()).toBe('/settings/profile');
    expect(screen.getByText('profile-view')).toBeTruthy();
  });

  it('an unknown section lands on Perfil', () => {
    authState.current = { can: () => true };
    renderAt('/settings/nada');
    expect(where()).toBe('/settings/profile');
  });

  it('opens Minha cidade under a header with its name, and no tab row', () => {
    authState.current = { can: () => true };
    renderAt('/settings/city');
    expect(screen.getByText('minha-cidade-view')).toBeTruthy();
    expect(titles()).toEqual(['Minha cidade']);
    expect(screen.queryByRole('link', { name: 'Usuários' })).toBeNull();
  });

  it('puts Usuários under one header, with Convidar among its actions', () => {
    authState.current = { can: () => true };
    renderAt('/settings/users');
    expect(titles()).toEqual(['Usuários']);
    expect(screen.getByRole('button', { name: 'Convidar' }).closest('header')).not.toBeNull();
  });

  it('puts Roles under one header, with + role among its actions', () => {
    authState.current = { can: () => true };
    renderAt('/settings/roles');
    expect(titles()).toEqual(['Roles']);
    expect(screen.getByRole('button', { name: '+ role' }).closest('header')).not.toBeNull();
  });

  it('gives Permissões a single header', () => {
    authState.current = { can: () => true };
    renderAt('/settings/permissions');
    expect(titles()).toEqual(['Permissões']);
  });

  it('opens Integrações as a section', () => {
    authState.current = { can: (r) => r === 'integrations' };
    renderAt('/settings/integrations');
    expect(screen.getByText('integrations-view')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Write the IntegrationsView and App route tests (failing)**

Create `apps/web/src/components/IntegrationsView.test.tsx`:
```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: { integrations: { list: () => Promise.resolve({ integrations: [] }) } },
}));

import { IntegrationsView } from './IntegrationsView';

const mount = () =>
  render(
    <MemoryRouter>
      <IntegrationsView />
    </MemoryRouter>,
  );

afterEach(cleanup);

describe('IntegrationsView', () => {
  it('sits under the shared header, "+ integração" among its actions and the explanation in the content', async () => {
    mount();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Integrações']);
    expect(screen.getByRole('button', { name: '+ integração' }).closest('header')).not.toBeNull();
    expect(screen.getByText(/Credenciais de GitHub, Linear e Jira/).closest('header')).toBeNull();
    expect(await screen.findByText('Nenhuma integração ainda.')).toBeInTheDocument();
  });

  it('"+ integração" opens the form', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: '+ integração' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
```

Create `apps/web/src/App.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The layouts become bare outlets and every page a marker: only the route table is under test.
vi.mock('./components/Layout', async () => {
  const { Outlet } = await import('react-router-dom');
  return { AppShell: () => <Outlet />, Layout: () => <Outlet />, FullScreenMessage: ({ children }: { children: ReactNode }) => <p>{children}</p> };
});
vi.mock('./components/ChatLayout', async () => {
  const { Outlet } = await import('react-router-dom');
  return { ChatLayout: () => <Outlet /> };
});
vi.mock('./pages/LoginPage', () => ({ LoginPage: () => <p>login-page</p> }));
vi.mock('./pages/HomePage', () => ({ HomePage: () => <p>home-page</p> }));
vi.mock('./pages/ProjectPage', () => ({ ProjectPage: () => <p>project-page</p> }));
vi.mock('./pages/ChatPage', () => ({ ChatPage: () => <p>chat-page</p> }));
vi.mock('./pages/MachinesPage', () => ({ MachinesPage: () => <p>machines-page</p> }));
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: () => <p>settings-page</p> }));

import { AppRoutes } from './App';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

afterEach(cleanup);

describe('AppRoutes', () => {
  it('sends the old /integrations address to the Integrações settings section', () => {
    render(
      <MemoryRouter initialEntries={['/integrations']}>
        <AppRoutes />
        <Where />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('where').textContent).toBe('/settings/integrations');
    expect(screen.getByText('settings-page')).toBeTruthy();
  });
});
```

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/pages/SettingsPage.test.tsx src/components/IntegrationsView.test.tsx src/App.test.tsx'; rm -rf .npm
```
Expected: FAIL — `/settings` stays at `/settings`, the tab row's `Usuários` link exists, several `h1`s per section, `AppRoutes` is not exported.

- [ ] **Step 3: Rewrite the SettingsPage component**

In `apps/web/src/pages/SettingsPage.tsx` replace lines 1-48 (imports, doc comment and `SettingsPage`) with:
```tsx
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { AccessStatus, InviteResult, PermissionAction, ResourcePermissions, Role, User } from '../lib/types';
import { DEFAULT_SETTINGS_SECTION, visibleSettingsSections } from '../lib/settings-sections';
import { ConfirmDialog, Modal } from '../components/Modal';
import { UploadsView } from '../components/UploadsView';
import { ApiTokensView } from '../components/ApiTokensView';
import { MyCityView } from '../components/MyCityView';
import { ProfileView } from '../components/ProfileView';
import { IntegrationsView } from '../components/IntegrationsView';
import { PageFrame } from '../components/PageHeader';

/**
 * Configurações' content: one section per address, each under the shared page header. The section
 * list itself is the settings sidebar (components/SettingsSidebar). Perfil, Minha cidade and
 * Integrações are the account's own; users, roles, the permission matrix (resource ×
 * create/read/update/delete) and uploads are administration. Same model as the engenhariainversa
 * CMS: admin roles bypass everything, system roles cannot be deleted.
 */

const ACTION_LABELS: Record<PermissionAction, string> = { create: 'Criar', read: 'Ver', update: 'Editar', delete: 'Excluir' };
const ACTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete'];

export function SettingsPage() {
  const { section } = useParams<{ section?: string }>();
  const { can } = useAuth();
  const current = visibleSettingsSections(can).find((s) => s.key === section);
  // `/settings`, an unknown address or a section this role cannot see: Perfil, which everyone sees
  if (!current) return <Navigate to={`/settings/${DEFAULT_SETTINGS_SECTION}`} replace />;

  switch (current.key) {
    case 'users':
      return <UsersSection />;
    case 'roles':
      return <RolesSection />;
    case 'integrations':
      return <IntegrationsView />;
    case 'permissions':
      return (
        <PageFrame title={current.label}>
          <PermissionsSection />
        </PageFrame>
      );
    case 'uploads':
      return (
        <PageFrame title={current.label}>
          <UploadsView />
        </PageFrame>
      );
    case 'api-tokens':
      return (
        <PageFrame title={current.label}>
          <ApiTokensView />
        </PageFrame>
      );
    case 'city':
      return (
        <PageFrame title={current.label}>
          <MyCityView />
        </PageFrame>
      );
    case 'profile':
      return (
        <PageFrame title={current.label}>
          <ProfileView />
        </PageFrame>
      );
  }
}
```

- [ ] **Step 4: Move Usuários' and Roles' titles and buttons into the header; drop Permissões' `h1`**

In `UsersSection` replace:
```tsx
  return (
    <div className="max-w-5xl">
      <div className="mb-4 flex items-start gap-3">
        <div>
          <h1 className="text-lg font-semibold">Usuários</h1>
          <p className="text-sm text-fg-muted">
            {users ? `${users.length} usuário(s).` : 'Carregando…'} Convide pelo e-mail: o usuário entra com Google ou com o código enviado por e-mail.
            {access?.configured && (
              <>
                {' '}
                Convites também liberam o e-mail no Cloudflare Access de <code className="font-mono text-xs">{access.domain}</code>.
              </>
            )}
          </p>
        </div>
        {can('users', 'create') && (
          <button className="btn-primary ml-auto text-xs" onClick={() => setInviting(true)}>
            Convidar
          </button>
        )}
      </div>
```
with:
```tsx
  return (
    <PageFrame
      title="Usuários"
      actions={
        can('users', 'create') && (
          <button className="btn-primary text-xs" onClick={() => setInviting(true)}>
            Convidar
          </button>
        )
      }
    >
    <div className="max-w-5xl">
      <p className="mb-4 text-sm text-fg-muted">
        {users ? `${users.length} usuário(s).` : 'Carregando…'} Convide pelo e-mail: o usuário entra com Google ou com o código enviado por e-mail.
        {access?.configured && (
          <>
            {' '}
            Convites também liberam o e-mail no Cloudflare Access de <code className="font-mono text-xs">{access.domain}</code>.
          </>
        )}
      </p>
```
and close the frame at the end of `UsersSection` — replace:
```tsx
      />
    </div>
  );
}

// ── Roles
```
with:
```tsx
      />
    </div>
    </PageFrame>
  );
}

// ── Roles
```

In `RolesSection` replace:
```tsx
  return (
    <div className="max-w-4xl">
      <div className="mb-4 flex items-end gap-4">
        <div>
          <h1 className="text-lg font-semibold">Roles</h1>
          <p className="text-sm text-fg-muted">Uma role é um conjunto de permissões. Roles de administrador têm acesso total; roles do sistema não podem ser excluídas.</p>
        </div>
        {can('roles', 'create') && (
          <button className="btn-primary ml-auto text-xs" onClick={() => setForm({ open: true, role: null })}>
            + role
          </button>
        )}
      </div>
```
with:
```tsx
  return (
    <PageFrame
      title="Roles"
      actions={
        can('roles', 'create') && (
          <button className="btn-primary text-xs" onClick={() => setForm({ open: true, role: null })}>
            + role
          </button>
        )
      }
    >
    <div className="max-w-4xl">
      <p className="mb-4 text-sm text-fg-muted">Uma role é um conjunto de permissões. Roles de administrador têm acesso total; roles do sistema não podem ser excluídas.</p>
```
and replace:
```tsx
      />
    </div>
  );
}

// ── Permissions matrix
```
with:
```tsx
      />
    </div>
    </PageFrame>
  );
}

// ── Permissions matrix
```

In `PermissionsSection` replace:
```tsx
      <div className="mb-4 flex items-end gap-4">
        <div>
          <h1 className="text-lg font-semibold">Permissões</h1>
          <p className="text-sm text-fg-muted">O que cada role pode fazer em cada recurso. Roles de administrador não aparecem aqui: têm acesso total.</p>
        </div>
```
with:
```tsx
      <div className="mb-4 flex items-end gap-4">
        <p className="text-sm text-fg-muted">O que cada role pode fazer em cada recurso. Roles de administrador não aparecem aqui: têm acesso total.</p>
```
(Re-indenting the wrapped bodies is optional; there is no formatter gate.)

- [ ] **Step 5: Integrações and Minha cidade under the header**

In `apps/web/src/components/IntegrationsView.tsx` add `import { PageFrame } from './PageHeader';` after the `./Modal` import, then replace:
```tsx
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-5 flex items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold">Integrações</h1>
          <p className="text-sm text-fg-muted">Credenciais de GitHub, Linear e Jira. Os segredos ficam criptografados no banco; cada projeto escolhe qual usar no Setup.</p>
        </div>
        <button className="btn-primary ml-auto" onClick={() => setEditing('new')}>
          + integração
        </button>
      </div>
```
with:
```tsx
  return (
    <PageFrame
      title="Integrações"
      actions={
        <button className="btn-primary text-xs" onClick={() => setEditing('new')}>
          + integração
        </button>
      }
    >
      <p className="mb-5 max-w-2xl text-sm text-fg-muted">Credenciais de GitHub, Linear e Jira. Os segredos ficam criptografados no banco; cada projeto escolhe qual usar no Setup.</p>
```
and replace:
```tsx
          void load();
        }}
      />
    </div>
  );
}
```
with:
```tsx
          void load();
        }}
      />
    </PageFrame>
  );
}
```

In `apps/web/src/components/MyCityView.tsx` replace:
```tsx
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Minha cidade</h1>
        <p className="text-sm text-fg-muted">Sua cidade pública mostra, para quem tiver o link, os projetos que você publicar, nas máquinas que são suas.</p>
      </div>
```
with:
```tsx
    <div className="max-w-4xl space-y-6">
      <p className="text-sm text-fg-muted">Sua cidade pública mostra, para quem tiver o link, os projetos que você publicar, nas máquinas que são suas.</p>
```

- [ ] **Step 6: Export the route table and redirect /integrations**

Replace the import block of `apps/web/src/App.tsx` (lines 1-15) so the `IntegrationsView` import from Task 2 is gone; `OfficePage`, `OfficeRoute` and `RouteFailed` below it stay as they are:
```tsx
import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './lib/auth';
import { AnalyticsGate } from './components/AnalyticsGate';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppShell, FullScreenMessage, Layout } from './components/Layout';
import { ChatLayout } from './components/ChatLayout';
import { retryOnceOnImportFailure } from './lib/lazy-retry';
import { LoginPage } from './pages/LoginPage';
import { HomePage } from './pages/HomePage';
import { ProjectPage } from './pages/ProjectPage';
import { ChatPage } from './pages/ChatPage';
import { MachinesPage } from './pages/MachinesPage';
import { SettingsPage } from './pages/SettingsPage';
```
and replace the whole `export function App() { … }` with:
```tsx
/** The route table, apart from the router and providers so a test can mount it in a MemoryRouter. */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppShell />}>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/ai" element={<HomePage />} />
          <Route path="/hardware" element={<HomePage />} />
          <Route path="/waitlist" element={<HomePage />} />
          {/* the old Integrações page is a settings section now; inside Layout so the layout (and
              what it remembers about the page before settings) survives the redirect */}
          <Route path="/integrations" element={<Navigate to="/settings/integrations" replace />} />
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:section" element={<SettingsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/projects/:id/:section" element={<ProjectPage />} />
          <Route path="/office" element={<OfficeRoute />} />
          <Route path="/office/:machineId" element={<OfficeRoute />} />
        </Route>
        <Route element={<ChatLayout />}>
          <Route path="/chat" element={<ChatPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AnalyticsGate>
          <AppRoutes />
        </AnalyticsGate>
      </AuthProvider>
    </BrowserRouter>
  );
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/pages/SettingsPage.test.tsx src/components/IntegrationsView.test.tsx src/App.test.tsx src/components/MyCityView.test.tsx'; rm -rf .npm
```
Expected: PASS (SettingsPage 8, IntegrationsView 2, App 1, MyCityView unchanged count).

- [ ] **Step 8: Run the web gate**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/web && npm run build:city -w @termhub/web && CI=1 npm test -w @termhub/web'; rm -rf .npm
```
Expected: typecheck clean (no unused `SettingsSection` import left), all web tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/pages/SettingsPage.tsx apps/web/src/pages/SettingsPage.test.tsx apps/web/src/components/IntegrationsView.tsx apps/web/src/components/IntegrationsView.test.tsx apps/web/src/components/MyCityView.tsx apps/web/src/App.tsx apps/web/src/App.test.tsx
git commit -m "Web: settings sections under the page header, /settings opens Perfil

Drops the settings tab row (the sidebar lists the sections from the
next commit on) and redirects the old /integrations page there.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Settings sidebar, the way back (button and Esc) and the slide

**Files:**
- Modify: `apps/web/src/components/Modal.tsx:12-29` (`useEscapeLayer` passes the event)
- Create: `apps/web/src/lib/settings-nav.ts`
- Test: `apps/web/src/lib/settings-nav.test.tsx`
- Create: `apps/web/src/components/settings-icons.ts`
- Create: `apps/web/src/components/SettingsSidebar.tsx`
- Test: `apps/web/src/components/SettingsSidebar.test.tsx`, `apps/web/src/components/SettingsSidebar.motion.test.ts`
- Modify: `apps/web/src/index.css` (append the animation)
- Modify: `apps/web/src/components/Layout.tsx` (whole file)
- Test: `apps/web/src/components/Layout.test.tsx` (new)

**Interfaces:**
- Consumes: `settingsGroups`, `SettingsSection` (Task 2).
- Produces:
  ```ts
  // components/Modal.tsx
  export function useEscapeLayer(open: boolean, onEscape: (e: KeyboardEvent) => void, enabled?: boolean): void;
  // lib/settings-nav.ts
  export function isSettingsPath(pathname: string): boolean;   // '/settings', '/settings/*', '/integrations'
  export function keepsEscape(target: EventTarget | null): boolean;
  export function useSettingsExit(): () => void;               // call once, in Layout
  // components/settings-icons.ts
  export const SETTINGS_ICONS: Record<SettingsSection, LucideIcon>;
  // components/SettingsSidebar.tsx
  export function SettingsSidebar(props: { onBack: () => void; onCollapse?: () => void }): JSX.Element;
  // components/Layout.tsx
  export function Chrome(props: { collapsed: boolean; setCollapsed: (v: boolean) => void; onLeaveSettings: () => void }): JSX.Element | null;
  ```
  Back control accessible name everywhere: `Voltar de Configurações`. The settings sidebar is `<aside aria-label="Configurações" class="chrome-slide-in …">`; its section nav is `<nav aria-label="Seções de Configurações">`, one `role="group"` per heading, named by the heading.

- [ ] **Step 1: Write the failing settings-nav test**

Create `apps/web/src/lib/settings-nav.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Link, MemoryRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { Modal } from '../components/Modal';
import { isSettingsPath, keepsEscape, useSettingsExit } from './settings-nav';

/** Stands in for Layout: stays mounted while the routes under it change, like the real one. */
function Shell() {
  const leave = useSettingsExit();
  const { pathname, search } = useLocation();
  const [dialog, setDialog] = useState(false);
  return (
    <>
      <p data-testid="where">{`${pathname}${search}`}</p>
      <button onClick={leave}>voltar</button>
      <button onClick={() => setDialog(true)}>abrir diálogo</button>
      <Link to="/settings/users">configurações</Link>
      <Link to="/integrations">integrações antigas</Link>
      <Routes>
        <Route path="/integrations" element={<Navigate to="/settings/integrations" replace />} />
        <Route
          path="/settings/:section"
          element={
            <>
              <input aria-label="nome" />
              <select aria-label="role">
                <option>a</option>
              </select>
            </>
          }
        />
        <Route path="*" element={<input aria-label="busca" />} />
      </Routes>
      <Modal open={dialog} onClose={() => setDialog(false)} title="Convidar usuário">
        <p>corpo</p>
      </Modal>
    </>
  );
}

const mount = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Shell />
    </MemoryRouter>,
  );
const where = () => screen.getByTestId('where').textContent;
const esc = (target: Element = document.body) => fireEvent.keyDown(target, { key: 'Escape' });
const enterSettings = () => fireEvent.click(screen.getByText('configurações'));

afterEach(cleanup);

describe('isSettingsPath', () => {
  it('covers /settings, its sections and the old /integrations address', () => {
    expect(['/settings', '/settings/users', '/integrations'].map(isSettingsPath)).toEqual([true, true, true]);
    expect(['/', '/machines', '/settingsx', '/projects/p1/settings'].map(isSettingsPath)).toEqual([false, false, false, false]);
  });
});

describe('keepsEscape', () => {
  it('is true in text fields and inside dialogs, false elsewhere', () => {
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const inDialog = document.createElement('button');
    dialog.appendChild(inDialog);
    expect(keepsEscape(document.createElement('input'))).toBe(true);
    expect(keepsEscape(document.createElement('textarea'))).toBe(true);
    expect(keepsEscape(document.createElement('select'))).toBe(true);
    expect(keepsEscape(inDialog)).toBe(true);
    expect(keepsEscape(document.createElement('div'))).toBe(false);
    expect(keepsEscape(null)).toBe(false);
  });
});

describe('useSettingsExit', () => {
  it('the back button returns to the last page outside settings, query included', () => {
    mount('/machines?x=1');
    enterSettings();
    expect(where()).toBe('/settings/users');
    fireEvent.click(screen.getByText('voltar'));
    expect(where()).toBe('/machines?x=1');
  });

  it('Esc does the same', () => {
    mount('/machines?x=1');
    enterSettings();
    esc();
    expect(where()).toBe('/machines?x=1');
  });

  it('goes to / when settings was the first page opened', () => {
    mount('/settings/users');
    esc();
    expect(where()).toBe('/');
  });

  it('leaves Esc to a text field or a select', () => {
    mount('/machines');
    enterSettings();
    esc(screen.getByLabelText('nome'));
    expect(where()).toBe('/settings/users');
    esc(screen.getByLabelText('role'));
    expect(where()).toBe('/settings/users');
  });

  it('lets an open dialog take Esc first', () => {
    mount('/machines');
    enterSettings();
    fireEvent.click(screen.getByText('abrir diálogo'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    esc();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(where()).toBe('/settings/users');
    esc();
    expect(where()).toBe('/machines');
  });

  it('does not remember the old /integrations address as a page to go back to', () => {
    mount('/machines');
    fireEvent.click(screen.getByText('integrações antigas'));
    expect(where()).toBe('/settings/integrations');
    esc();
    expect(where()).toBe('/machines');
  });

  it('does nothing with Esc outside settings', () => {
    mount('/machines');
    esc();
    expect(where()).toBe('/machines');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/lib/settings-nav.test.tsx'; rm -rf .npm
```
Expected: FAIL — `Failed to resolve import "./settings-nav"`.

- [ ] **Step 3: Pass the key event through the Escape stack, and write settings-nav**

In `apps/web/src/components/Modal.tsx` replace:
```ts
export function useEscapeLayer(open: boolean, onEscape: () => void, enabled = true): void {
```
with:
```ts
export function useEscapeLayer(open: boolean, onEscape: (e: KeyboardEvent) => void, enabled = true): void {
```
and replace:
```ts
      if (latest.current.enabled) latest.current.onEscape();
```
with:
```ts
      if (latest.current.enabled) latest.current.onEscape(e);
```

Create `apps/web/src/lib/settings-nav.ts`:
```ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/lib/settings-nav.test.tsx src/components/Modal.test.tsx'; rm -rf .npm
```
Expected: PASS (settings-nav 9 tests; Modal tests unchanged and green).

- [ ] **Step 5: Write the failing SettingsSidebar tests**

Create `apps/web/src/components/SettingsSidebar.test.tsx`:
```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ can: (() => true) as (resource: string, action?: string) => boolean }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: authState.can }) }));

import { SettingsSidebar } from './SettingsSidebar';

function mount(path = '/settings/profile', onCollapse?: () => void) {
  const onBack = vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <SettingsSidebar onBack={onBack} onCollapse={onCollapse} />
    </MemoryRouter>,
  );
  return onBack;
}
const linksOf = (group: string) =>
  within(screen.getByRole('group', { name: group }))
    .getAllByRole('link')
    .map((l) => [l.textContent, l.getAttribute('href')]);

beforeEach(() => {
  authState.can = () => true;
});
afterEach(cleanup);

describe('SettingsSidebar', () => {
  it('lists the sections under Conta and Administração, with icons', () => {
    mount();
    expect(linksOf('Conta')).toEqual([
      ['Perfil', '/settings/profile'],
      ['Minha cidade', '/settings/city'],
      ['Integrações', '/settings/integrations'],
      ['Tokens de API', '/settings/api-tokens'],
    ]);
    expect(linksOf('Administração')).toEqual([
      ['Usuários', '/settings/users'],
      ['Roles', '/settings/roles'],
      ['Permissões', '/settings/permissions'],
      ['Arquivos', '/settings/uploads'],
    ]);
    expect(screen.getByRole('link', { name: 'Perfil' }).querySelector('svg')).not.toBeNull();
  });

  it('shows only Conta to a user with no admin grants', () => {
    authState.can = () => false;
    mount();
    expect(linksOf('Conta')).toEqual([
      ['Perfil', '/settings/profile'],
      ['Minha cidade', '/settings/city'],
    ]);
    expect(screen.queryByRole('group', { name: 'Administração' })).toBeNull();
    expect(screen.queryByText('Administração')).toBeNull();
  });

  it('marks the open section', () => {
    mount('/settings/users');
    expect(screen.getByRole('link', { name: 'Usuários' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Perfil' })).not.toHaveAttribute('aria-current');
  });

  it('goes back from its header', () => {
    const onBack = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Voltar de Configurações' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('collapses only when the layout allows it', () => {
    mount();
    expect(screen.queryByRole('button', { name: 'Recolher sidebar' })).toBeNull();
    cleanup();
    const onCollapse = vi.fn();
    mount('/settings/profile', onCollapse);
    fireEvent.click(screen.getByRole('button', { name: 'Recolher sidebar' }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('slides in', () => {
    mount();
    expect(screen.getByRole('complementary', { name: 'Configurações' })).toHaveClass('chrome-slide-in');
  });
});
```

Create `apps/web/src/components/SettingsSidebar.motion.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../index.css', import.meta.url).pathname, 'utf8');

describe('the settings sidebar slide', () => {
  it('moves by transform for 150 ms', () => {
    expect(css).toMatch(/@keyframes chrome-slide-in\s*\{\s*from\s*\{\s*transform:\s*translateX\(-100%\);?\s*\}/);
    expect(css).toMatch(/\.chrome-slide-in\s*\{\s*animation:\s*chrome-slide-in 150ms ease-out;?\s*\}/);
  });

  it('does not move at all under reduced motion', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.chrome-slide-in\s*\{\s*animation:\s*none;?\s*\}\s*\}/);
  });
});
```

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/SettingsSidebar'; rm -rf .npm
```
Expected: FAIL — `Failed to resolve import "./SettingsSidebar"`, and the CSS regexes do not match.

- [ ] **Step 6: Write the icons map, the sidebar and the animation**

Create `apps/web/src/components/settings-icons.ts`:
```ts
import { Folder, KeyRound, ListChecks, Map as MapIcon, Plug, Shield, User as UserIcon, Users, type LucideIcon } from 'lucide-react';
import type { SettingsSection } from '../lib/settings-sections';

/** Each settings section's line icon (spec 2026-09-23 app chrome §2), for the settings sidebar and the rail. */
export const SETTINGS_ICONS: Record<SettingsSection, LucideIcon> = {
  profile: UserIcon,
  city: MapIcon,
  integrations: Plug,
  'api-tokens': KeyRound,
  users: Users,
  roles: Shield,
  permissions: ListChecks,
  uploads: Folder,
};
```

Create `apps/web/src/components/SettingsSidebar.tsx`:
```tsx
import { ArrowLeft, ChevronsLeft } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { settingsGroups } from '../lib/settings-sections';
import { SETTINGS_ICONS } from './settings-icons';

const GROUP_LABEL = 'px-3 pb-1 pt-2 text-[10px] uppercase tracking-wide text-fg-dim';

/**
 * Configurações as a sidebar (spec 2026-09-23 app chrome §4): it takes the projects sidebar's place
 * under /settings, sliding in, and lists the sections under Conta and Administração — a heading shows
 * only when something under it does. Going back (this button, or Esc through the layout) returns to
 * the last page outside settings.
 */
export function SettingsSidebar({ onBack, onCollapse }: { onBack: () => void; onCollapse?: () => void }) {
  const { can } = useAuth();
  return (
    <aside aria-label="Configurações" className="chrome-slide-in flex h-full w-64 shrink-0 flex-col border-r border-line bg-bg-2">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-2">
        <button
          type="button"
          className="flex items-center gap-2 rounded px-2 py-1 text-sm font-semibold hover:bg-bg-3"
          onClick={onBack}
          title="Voltar (Esc)"
          aria-label="Voltar de Configurações"
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Configurações
        </button>
        {onCollapse && (
          <button type="button" className="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onCollapse} title="Recolher sidebar" aria-label="Recolher sidebar">
            <ChevronsLeft size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <nav aria-label="Seções de Configurações" className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        {settingsGroups(can).map((g) => (
          <div key={g.id} role="group" aria-labelledby={`settings-group-${g.id}`} className="mb-2">
            <p id={`settings-group-${g.id}`} className={GROUP_LABEL}>
              {g.label}
            </p>
            {g.sections.map((s) => {
              const Icon = SETTINGS_ICONS[s.key];
              return (
                <NavLink
                  key={s.key}
                  to={`/settings/${s.key}`}
                  className={({ isActive }) => `flex items-center gap-2 rounded px-3 py-1.5 text-sm ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
                >
                  <Icon size={16} aria-hidden="true" />
                  {s.label}
                </NavLink>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
```

Append to `apps/web/src/index.css`:
```css

/* The settings sidebar slides in over the projects one (spec 2026-09-23 app chrome §4); no motion
   for whoever asked the system for none. */
@keyframes chrome-slide-in { from { transform: translateX(-100%); } to { transform: translateX(0); } }
.chrome-slide-in { animation: chrome-slide-in 150ms ease-out; }
@media (prefers-reduced-motion: reduce) { .chrome-slide-in { animation: none; } }
```

- [ ] **Step 7: Run them to verify they pass**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/SettingsSidebar'; rm -rf .npm
```
Expected: PASS (6 + 2 tests).

- [ ] **Step 8: Write the failing Chrome test**

Create `apps/web/src/components/Layout.test.tsx`:
```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./Sidebar', () => ({ Sidebar: () => <p>projects-sidebar</p> }));
vi.mock('./SettingsSidebar', () => ({ SettingsSidebar: ({ onBack }: { onBack: () => void }) => <button onClick={onBack}>settings-sidebar</button> }));
vi.mock('./chat/ChatDrawer', () => ({ ChatDrawer: () => null }));

import { FocusProvider } from '../lib/focus';
import { Chrome } from './Layout';

function mount(path: string, collapsed = false) {
  const onLeaveSettings = vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <FocusProvider>
        <Chrome collapsed={collapsed} setCollapsed={() => {}} onLeaveSettings={onLeaveSettings} />
      </FocusProvider>
    </MemoryRouter>,
  );
  return onLeaveSettings;
}

afterEach(cleanup);

describe('Chrome', () => {
  it('shows the projects sidebar outside settings', () => {
    mount('/machines');
    expect(screen.getByText('projects-sidebar')).toBeTruthy();
    expect(screen.queryByText('settings-sidebar')).toBeNull();
  });

  it('swaps in the settings sidebar under /settings, wired to the way back', () => {
    const leave = mount('/settings/users');
    expect(screen.queryByText('projects-sidebar')).toBeNull();
    fireEvent.click(screen.getByText('settings-sidebar'));
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it('hides all chrome in the office focus mode', () => {
    mount('/office?focus=1');
    expect(screen.queryByText('projects-sidebar')).toBeNull();
    expect(screen.queryByText('settings-sidebar')).toBeNull();
  });
});
```

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/Layout.test.tsx'; rm -rf .npm
```
Expected: FAIL — `Chrome` is not exported (`Chrome is not a function` / undefined element).

- [ ] **Step 9: Switch the sidebar slot by route**

Replace `apps/web/src/components/Layout.tsx` with:
```tsx
import { useEffect, useState } from 'react';
import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { DataProvider } from '../lib/data';
import { FocusProvider, useFocusMode } from '../lib/focus';
import { MonitorProvider } from '../lib/monitor';
import { ProjectChatProvider } from '../lib/project-chat';
import { ProjectGroupsProvider } from '../lib/project-groups';
import { isSettingsPath, useSettingsExit } from '../lib/settings-nav';
import { ToastProvider, Toaster } from '../lib/toast';
import { ChatDrawer } from './chat/ChatDrawer';
import { NeedsYouToasts } from './NeedsYouToasts';
import { SettingsSidebar } from './SettingsSidebar';
import { Sidebar } from './Sidebar';
import { NicknamePrompt } from './NicknamePrompt';

const SIDEBAR_KEY = 'termhub:sidebar-collapsed';

/**
 * Everything signed-in routes need that isn't visual chrome: the auth guard, the
 * data/monitor/toast providers and the "precisando de você" overlays. Both the sidebar layout
 * (`Layout`) and the chat's full-screen layout (`ChatLayout`) render under this, so a chat page
 * still receives monitor pushes and toasts.
 */
export function AppShell() {
  const { user, loading } = useAuth();

  if (loading) return <FullScreenMessage>Carregando…</FullScreenMessage>;
  if (!user) return <Navigate to="/login" replace />;
  return (
    <DataProvider>
      <MonitorProvider>
        <ProjectGroupsProvider>
          <ToastProvider>
            <Outlet />
            <NeedsYouToasts />
            <NicknamePrompt />
            <Toaster />
          </ToastProvider>
        </ProjectGroupsProvider>
      </MonitorProvider>
    </DataProvider>
  );
}

export function Layout() {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  }, [collapsed]);
  // remembers the last page outside settings and answers Esc under settings (lib/settings-nav)
  const leaveSettings = useSettingsExit();

  return (
    <FocusProvider>
      <ProjectChatProvider>
        <div className="flex h-full">
          <Chrome collapsed={collapsed} setCollapsed={setCollapsed} onLeaveSettings={leaveSettings} />
          <main className="relative min-w-0 flex-1">
            <Outlet />
          </main>
        </div>
        <ChatDrawer />
      </ProjectChatProvider>
    </FocusProvider>
  );
}

/**
 * The sidebar slot: Configurações' own sidebar under /settings, the projects sidebar elsewhere, the
 * rail when collapsed. Hidden entirely while the page is in focus mode — only `/office` has one (lib/focus).
 */
export function Chrome({ collapsed, setCollapsed, onLeaveSettings }: { collapsed: boolean; setCollapsed: (v: boolean) => void; onLeaveSettings: () => void }) {
  const { focus } = useFocusMode();
  const { pathname } = useLocation();
  if (focus) return null;
  if (collapsed) return <SidebarRail onExpand={() => setCollapsed(false)} />;
  if (isSettingsPath(pathname)) return <SettingsSidebar onBack={onLeaveSettings} onCollapse={() => setCollapsed(true)} />;
  return <Sidebar onCollapse={() => setCollapsed(true)} />;
}

/** Sidebar recolhida: uma faixa estreita com o logo e o botão de expandir (o terminal ganha o espaço). */
function SidebarRail({ onExpand }: { onExpand: () => void }) {
  return (
    <aside className="flex h-full w-9 shrink-0 flex-col items-center border-r border-line bg-bg-2">
      <NavLink to="/" className="flex h-11 w-full items-center justify-center border-b border-line text-sm font-semibold text-accent" title="termhub — início">
        ▮
      </NavLink>
      <button className="mt-1 rounded px-2 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onExpand} title="Mostrar sidebar" aria-label="Mostrar sidebar">
        »
      </button>
    </aside>
  );
}

export function FullScreenMessage({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center text-sm text-fg-muted">{children}</div>;
}
```
(The internal `SidebarRail` is replaced in Task 6.)

- [ ] **Step 10: Run it to verify it passes, then the gate**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/Layout.test.tsx'; rm -rf .npm
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/web && npm run build:city -w @termhub/web && CI=1 npm test -w @termhub/web'; rm -rf .npm
```
Expected: Layout 3 tests PASS; typecheck clean; all web tests pass (ChatDrawer and Modal callers compile with the widened `onEscape` type).

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/Modal.tsx apps/web/src/lib/settings-nav.ts apps/web/src/lib/settings-nav.test.tsx apps/web/src/components/settings-icons.ts apps/web/src/components/SettingsSidebar.tsx apps/web/src/components/SettingsSidebar.test.tsx apps/web/src/components/SettingsSidebar.motion.test.ts apps/web/src/index.css apps/web/src/components/Layout.tsx apps/web/src/components/Layout.test.tsx
git commit -m "Web: settings sidebar with a way back (button and Esc)

Under /settings the sidebar slot shows the settings sections, sliding
in unless reduced motion is on; back returns to the last page outside
settings, and Esc does too unless a text field or dialog owns it.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Main sidebar bottom — daily menus with icons and the profile button

**Files:**
- Create: `apps/web/src/components/MainNav.tsx`, `apps/web/src/components/ProfileButton.tsx`
- Test: `apps/web/src/components/MainNav.test.tsx`, `apps/web/src/components/ProfileButton.test.tsx`
- Modify: `apps/web/src/components/Sidebar.tsx` (imports lines 1-21; `useAuth`/`useMonitor`/`useNavigate` lines 70-76; collapse button 339-343; bottom lines 382-435)
- Modify: `apps/web/src/components/Sidebar.test.tsx` (`Sidebar footer` block, imports)
- Modify: `apps/web/src/lib/settings-sections.ts`, `apps/web/src/lib/settings-sections.test.ts` (remove `canSeeSettings`)

**Interfaces:**
- Consumes: `Avatar` (Task 2).
- Produces:
  ```ts
  export function MainNav(props: { variant: 'list' | 'rail' }): JSX.Element | null;   // <nav aria-label="Menu principal">
  export function ProfileButton(props: { variant: 'row' | 'rail' }): JSX.Element;     // <button aria-label="Configurações e perfil"> → /settings/profile
  ```
  Rail variant: each link `aria-label` = label, or `"<label>, alguém precisa de você"` when the dot shows; `title` = label; icons 18. List variant: icon 16 + label, the dot is `<i aria-label="alguém precisa de você">`.

- [ ] **Step 1: Write the failing MainNav and ProfileButton tests**

Create `apps/web/src/components/MainNav.test.tsx`:
```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ can: (() => true) as (resource: string, action?: string) => boolean, needsYou: [] as unknown[] }));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: state.can }) }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ needsYou: state.needsYou }) }));

import { MainNav } from './MainNav';

const mount = (variant: 'list' | 'rail') =>
  render(
    <MemoryRouter>
      <MainNav variant={variant} />
    </MemoryRouter>,
  );

beforeEach(() => {
  state.can = () => true;
  state.needsYou = [];
});
afterEach(cleanup);

describe('MainNav', () => {
  it('lists Escritório, Chat and Máquinas, in that order, with icons', () => {
    mount('list');
    const links = within(screen.getByRole('navigation', { name: 'Menu principal' })).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Escritório', '/office'],
      ['Chat', '/chat'],
      ['Máquinas', '/machines'],
    ]);
    for (const l of links) expect(l.querySelector('svg')).not.toBeNull();
  });

  it('shows each menu only under its permission', () => {
    // projects:read without terminals:read is not enough for Escritório; no chat grant
    state.can = (r, a) => r === 'machines' || (r === 'projects' && a === 'read');
    mount('list');
    expect(screen.getAllByRole('link').map((l) => l.textContent)).toEqual(['Máquinas']);
  });

  it('renders nothing when no menu is allowed', () => {
    state.can = () => false;
    const { container } = mount('list');
    expect(container).toBeEmptyDOMElement();
  });

  it('puts the attention dot on Escritório when someone needs you', () => {
    mount('list');
    expect(screen.queryByLabelText('alguém precisa de você')).toBeNull();
    cleanup();
    state.needsYou = [{}];
    mount('list');
    expect(within(screen.getByRole('link', { name: /Escritório/ })).getByLabelText('alguém precisa de você')).toBeInTheDocument();
  });

  it('in the rail, shows icons named and titled by their label, the dot in the name', () => {
    state.needsYou = [{}];
    mount('rail');
    const office = screen.getByRole('link', { name: 'Escritório, alguém precisa de você' });
    expect(office).toHaveAttribute('title', 'Escritório');
    expect(screen.getByRole('link', { name: 'Chat' }).textContent).toBe('');
    expect(screen.getByRole('link', { name: 'Máquinas' })).toHaveAttribute('href', '/machines');
  });
});
```

Create `apps/web/src/components/ProfileButton.test.tsx`:
```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/auth', () => ({ useAuth: () => ({ user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'pedro@example.com' } }) }));

import { ProfileButton } from './ProfileButton';

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}
function mount(variant: 'row' | 'rail') {
  render(
    <MemoryRouter initialEntries={['/machines']}>
      <ProfileButton variant={variant} />
      <Where />
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('ProfileButton', () => {
  it('the row is one button with the name that opens Perfil', () => {
    mount('row');
    const button = screen.getByRole('button', { name: 'Configurações e perfil' });
    expect(button).toHaveTextContent('Pedro');
    expect(button.querySelector('svg')).not.toBeNull(); // the Settings gear
    fireEvent.click(button);
    expect(screen.getByTestId('where').textContent).toBe('/settings/profile');
  });

  it('the rail shows only the avatar, with the same destination', () => {
    mount('rail');
    const button = screen.getByRole('button', { name: 'Configurações e perfil' });
    expect(button).not.toHaveTextContent('Pedro');
    fireEvent.click(button);
    expect(screen.getByTestId('where').textContent).toBe('/settings/profile');
  });
});
```

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/MainNav.test.tsx src/components/ProfileButton.test.tsx'; rm -rf .npm
```
Expected: FAIL — `Failed to resolve import "./MainNav"` / `"./ProfileButton"`.

- [ ] **Step 2: Write MainNav and ProfileButton**

Create `apps/web/src/components/MainNav.tsx`:
```tsx
import { Building2, MessageSquare, Monitor, type LucideIcon } from 'lucide-react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useMonitor } from '../lib/monitor';

interface Item {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Escritório's "someone needs you" dot */
  dot: boolean;
}

/**
 * The daily menus — Escritório, Chat, Máquinas — each under its permission (spec 2026-09-23 app
 * chrome §3). `list` is the open sidebar's rows; `rail` the collapsed sidebar's icons, named by label.
 */
export function MainNav({ variant }: { variant: 'list' | 'rail' }) {
  const { can } = useAuth();
  const { needsYou } = useMonitor();
  const items: Item[] = [];
  if (can('projects', 'read') && can('terminals', 'read')) items.push({ to: '/office', label: 'Escritório', icon: Building2, dot: needsYou.length > 0 });
  if (can('chat')) items.push({ to: '/chat', label: 'Chat', icon: MessageSquare, dot: false });
  if (can('machines')) items.push({ to: '/machines', label: 'Máquinas', icon: Monitor, dot: false });
  if (items.length === 0) return null;

  if (variant === 'rail') {
    return (
      <nav aria-label="Menu principal" className="flex w-full shrink-0 flex-col items-center gap-1 border-t border-line py-2">
        {items.map(({ to, label, icon: Icon, dot }) => (
          <NavLink
            key={to}
            to={to}
            aria-label={dot ? `${label}, alguém precisa de você` : label}
            title={label}
            className={({ isActive }) => `relative flex h-8 w-8 items-center justify-center rounded ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
          >
            <Icon size={18} aria-hidden="true" />
            {dot && <i aria-hidden="true" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-attention" />}
          </NavLink>
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Menu principal" className="shrink-0 border-t border-line px-3 py-1.5">
      {items.map(({ to, label, icon: Icon, dot }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `flex items-center gap-2 rounded px-2 py-1 text-xs ${isActive ? 'bg-bg-4 text-fg' : 'text-fg-muted hover:bg-bg-3 hover:text-fg'}`}
        >
          <Icon size={16} aria-hidden="true" />
          <span className="flex-1">{label}</span>
          {dot && <i className="h-1.5 w-1.5 rounded-full bg-attention" aria-label="alguém precisa de você" />}
        </NavLink>
      ))}
    </nav>
  );
}
```

Create `apps/web/src/components/ProfileButton.tsx`:
```tsx
import { Settings as SettingsIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Avatar } from './Avatar';

/**
 * The way into Configurações (spec 2026-09-23 app chrome §3, §5): the whole profile row — avatar,
 * name, gear — is one button that opens Perfil; in the rail, just the avatar.
 */
export function ProfileButton({ variant }: { variant: 'row' | 'rail' }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const open = () => navigate('/settings/profile');

  if (variant === 'rail') {
    return (
      <button type="button" className="mb-2 shrink-0 rounded-full p-1 hover:bg-bg-3" onClick={open} aria-label="Configurações e perfil" title={user?.name ?? 'Configurações e perfil'}>
        <Avatar user={user} size={28} />
      </button>
    );
  }
  return (
    <button type="button" className="flex w-full shrink-0 items-center gap-2 border-t border-line px-3 py-2 text-left hover:bg-bg-3" onClick={open} aria-label="Configurações e perfil" title={user?.email}>
      <Avatar user={user} size={24} />
      <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{user?.name}</span>
      <SettingsIcon size={16} aria-hidden="true" className="shrink-0 text-fg-dim" />
    </button>
  );
}
```

- [ ] **Step 3: Run them to verify they pass**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/MainNav.test.tsx src/components/ProfileButton.test.tsx'; rm -rf .npm
```
Expected: PASS (5 + 2 tests).

- [ ] **Step 4: Update the Sidebar test for the new bottom (failing)**

In `apps/web/src/components/Sidebar.test.tsx` change the router import to:
```tsx
import { MemoryRouter, useLocation } from 'react-router-dom';
```
and replace the whole `describe('Sidebar footer', …)` block with:
```tsx
describe('Sidebar footer', () => {
  it('has a "Máquinas" nav link to /machines and a single "Novo projeto" add button', () => {
    renderSidebar();
    const machinesLink = screen.getByRole('link', { name: /Máquinas/ });
    expect(machinesLink).toHaveAttribute('href', '/machines');
    expect(screen.getByTitle('Novo projeto')).toBeInTheDocument();
    expect(screen.queryByText('+ máquina')).not.toBeInTheDocument();
  });

  it('shows the daily menus with icons, Escritório first', () => {
    renderSidebar();
    const links = within(screen.getByRole('navigation', { name: 'Menu principal' })).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual(['Escritório', 'Chat', 'Máquinas']);
    expect(links[0].querySelector('svg')).not.toBeNull();
  });

  it('ends with the profile row, which opens Perfil', () => {
    let where = '';
    function Where() {
      where = useLocation().pathname;
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar />
        <Where />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Configurações e perfil' }));
    expect(where).toBe('/settings/profile');
  });

  it('no longer carries Ver como, Integrações, Configurações, Cookies or Sair', () => {
    renderSidebar();
    for (const name of [/Ver como/, /Integrações/, /^Configurações$/, /Cookies/, /^Sair$/]) {
      expect(screen.queryByRole('link', { name })).toBeNull();
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('collapses with a line icon', () => {
    render(
      <MemoryRouter>
        <Sidebar onCollapse={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: 'Recolher sidebar' }).querySelector('svg')).not.toBeNull();
  });
});
```

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/Sidebar.test.tsx'; rm -rf .npm
```
Expected: FAIL — no "Menu principal" nav, no "Configurações e perfil" button, the `Integrações`/`Configurações`/`Sair` controls still exist, the collapse button has no svg.

- [ ] **Step 5: Rebuild the Sidebar bottom**

In `apps/web/src/components/Sidebar.tsx`:

Replace lines 1-21 (imports) with:
```tsx
import { ChevronsLeft } from 'lucide-react';
import { useMemo, useRef, useState, type DragEvent, type HTMLAttributes } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { needsYouByProject } from '../lib/needs-you';
import { useProjectChat } from '../lib/project-chat';
import { applyDrop, buildSections, type DragSource, type Section, type SectionId } from '../lib/project-groups-model';
import { useProjectGroups } from '../lib/project-groups';
import { decodeGroupDrag, decodeProjectDrag, encodeProjectDrag, GROUP_MIME, PROJECT_MIME, slotFor } from '../lib/sidebar-dnd';
import { loadCollapsedGroups, loadCollapsedProjects, saveCollapsedGroups, saveCollapsedProjects } from '../lib/sidebar-prefs';
import type { Project, ProjectGroup, Tab } from '../lib/types';
import { GroupHeader } from './GroupHeader';
import { MainNav } from './MainNav';
import { ProfileButton } from './ProfileButton';
import { ProjectForm } from './ProjectForm';
import { ProjectGroupsMenu } from './ProjectGroupsMenu';
import { ProjectRow } from './ProjectRow';
import { ConfirmDialog } from './Modal';
```

Replace:
```tsx
  const { user, logout, can } = useAuth();
  const { projects, machinesOf, loading } = useData();
  const { items: monitorItems, openTabs, needsYou } = useMonitor();
```
with:
```tsx
  const { can } = useAuth();
  const { projects, machinesOf, loading } = useData();
  const { items: monitorItems, openTabs } = useMonitor();
```
and delete the line:
```tsx
  const navigate = useNavigate();
```

Replace the collapse button:
```tsx
            <button className="rounded px-1.5 py-1 text-xs text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onCollapse} title="Recolher sidebar" aria-label="Recolher sidebar">
              «
            </button>
```
with:
```tsx
            <button className="rounded p-1 text-fg-dim hover:bg-bg-3 hover:text-fg" onClick={onCollapse} title="Recolher sidebar" aria-label="Recolher sidebar">
              <ChevronsLeft size={16} aria-hidden="true" />
            </button>
```

Replace everything from `      <ViewAsSwitch />` down to (and including) the profile row's closing `      </div>` just before `{projectFormOpen && …}` (original lines 382-435) with:
```tsx
      <MainNav variant="list" />
      <ProfileButton variant="row" />
```

- [ ] **Step 6: Remove canSeeSettings (Perfil makes it always true)**

In `apps/web/src/lib/settings-sections.ts` delete:
```ts

export function canSeeSettings(can: (resource: string) => boolean): boolean {
  return visibleSettingsSections(can).length > 0;
}
```
In `apps/web/src/lib/settings-sections.test.ts` change the import to:
```ts
import { DEFAULT_SETTINGS_SECTION, SETTINGS_SECTIONS, settingsGroups, visibleSettingsSections } from './settings-sections';
```
and delete the test:
```ts

  it('always shows Configurações', () => {
    expect(canSeeSettings(() => false)).toBe(true);
  });
```

- [ ] **Step 7: Run the tests and the gate**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/Sidebar src/lib/settings-sections.test.ts'; rm -rf .npm
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/web && npm run build:city -w @termhub/web && CI=1 npm test -w @termhub/web'; rm -rf .npm
```
Expected: Sidebar, Sidebar.dnd and settings-sections PASS; typecheck clean (no unused imports: `ANALYTICS_ENABLED`, `openCookieBanner`, `ViewAsSwitch`, `canSeeSettings`, `useNavigate` are gone); all web tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/MainNav.tsx apps/web/src/components/MainNav.test.tsx apps/web/src/components/ProfileButton.tsx apps/web/src/components/ProfileButton.test.tsx apps/web/src/components/Sidebar.tsx apps/web/src/components/Sidebar.test.tsx apps/web/src/lib/settings-sections.ts apps/web/src/lib/settings-sections.test.ts
git commit -m "Web: sidebar bottom with icon menus and a profile button

Escritório, Chat and Máquinas keep their permission checks; the profile
row opens Perfil. Ver como, Integrações, Cookies and Sair moved into
Configurações.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The rail — Favoritos, daily icons, avatar, and its settings mode

**Files:**
- Create: `apps/web/src/lib/project-initials.ts`
- Test: `apps/web/src/lib/project-initials.test.ts`
- Modify: `apps/web/src/lib/project-groups-model.ts` (append `favoriteProjects`), `apps/web/src/lib/project-groups-model.test.ts` (import + new `describe`)
- Create: `apps/web/src/components/SidebarRail.tsx`
- Test: `apps/web/src/components/SidebarRail.test.tsx`
- Modify: `apps/web/src/components/Layout.tsx` (use the new rail), `apps/web/src/components/Layout.test.tsx`

**Interfaces:**
- Consumes: `MainNav`, `ProfileButton` (Task 5); `SETTINGS_ICONS` (Task 4); `visibleSettingsSections` (Task 2); `isSettingsPath` (Task 4); `buildSections` (existing); `needsYouByProject` (existing).
- Produces:
  ```ts
  export function projectInitials(name: string): string;                                  // lib/project-initials.ts
  export function favoriteProjects(projects: Project[], groups: ProjectGroup[]): Project[]; // lib/project-groups-model.ts
  export function SidebarRail(props: { mode: 'main' | 'settings'; onExpand: () => void; onBack: () => void }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing helper tests**

Create `apps/web/src/lib/project-initials.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { projectInitials } from './project-initials';

describe('projectInitials', () => {
  it('takes the first two letters of the name, uppercased', () => {
    expect(projectInitials('termhub')).toBe('TE');
  });
  it('keeps a one-letter name as that letter', () => {
    expect(projectInitials('x')).toBe('X');
  });
  it('ignores surrounding spaces and keeps accents', () => {
    expect(projectInitials('  ética ')).toBe('ÉT');
  });
  it('never splits an emoji in half', () => {
    expect(projectInitials('🚀rocket')).toBe('🚀R');
  });
  it('falls back to ? for a blank name', () => {
    expect(projectInitials('   ')).toBe('?');
  });
});
```

In `apps/web/src/lib/project-groups-model.test.ts` change the import to:
```ts
import { applyDrop, buildSections, favoriteProjects, moveGroup } from './project-groups-model';
```
and append:
```ts

describe('favoriteProjects', () => {
  it('lists Favoritos in its own order, leaving out archived and unknown projects', () => {
    const groups: ProjectGroup[] = [{ id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ['c', 'z', 'gone', 'a'] }, ...G().slice(1)];
    expect(favoriteProjects(P, groups).map((p) => p.id)).toEqual(['c', 'a']);
  });

  it('is empty while the groups have not loaded', () => {
    expect(favoriteProjects(P, [])).toEqual([]);
  });
});
```

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/lib/project-initials.test.ts src/lib/project-groups-model.test.ts'; rm -rf .npm
```
Expected: FAIL — `./project-initials` does not resolve; `favoriteProjects is not a function`.

- [ ] **Step 2: Write the helpers**

Create `apps/web/src/lib/project-initials.ts`:
```ts
/**
 * What a project's square in the collapsed rail shows (spec 2026-09-23 app chrome §5): the first two
 * characters of its name, uppercased — one for a one-letter name. Counted by code point, so an emoji
 * is never cut in half; a blank name shows "?".
 */
export function projectInitials(name: string): string {
  const chars = Array.from(name.trim());
  return chars.length ? chars.slice(0, 2).join('').toUpperCase() : '?';
}
```

Append to `apps/web/src/lib/project-groups-model.ts`:
```ts

/** The Favoritos section's projects in its order, archived ones left out — what the collapsed rail shows. */
export function favoriteProjects(projects: Project[], groups: ProjectGroup[]): Project[] {
  return buildSections(projects, groups, new Set(), false).find((s) => s.kind === 'favorites')?.projects ?? [];
}
```

Run the Step 1 command again. Expected: PASS.

- [ ] **Step 3: Write the failing rail test**

Create `apps/web/src/components/SidebarRail.test.tsx`:
```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MonitorItem, Project, ProjectGroup, Tab } from '../lib/types';

const state = vi.hoisted(() => ({
  can: (() => true) as (resource: string, action?: string) => boolean,
  projects: [] as Project[],
  groups: [] as ProjectGroup[],
  items: [] as MonitorItem[],
}));
vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: state.can, user: { id: 'u1', name: 'Pedro', avatar_url: null, email: 'pedro@example.com' } }) }));
vi.mock('../lib/data', () => ({ useData: () => ({ projects: state.projects }) }));
vi.mock('../lib/project-groups', () => ({ useProjectGroups: () => ({ groups: state.groups }) }));
vi.mock('../lib/monitor', () => ({ useMonitor: () => ({ items: state.items, needsYou: state.items }) }));

import { SidebarRail } from './SidebarRail';

const project = (id: string, name: string, over: Partial<Project> = {}) => ({ id, key: name.toUpperCase(), name, status: 'active', machines: [], ...over }) as unknown as Project;
const waitingOn = (p: Project): MonitorItem =>
  ({ tab: { id: `t-${p.id}`, project_id: p.id, state: 'waiting_input', state_at: '2026-09-23T10:00:00.000Z', state_seen_at: null } as Tab, project: p, machine: {} }) as unknown as MonitorItem;

function mount(path: string, mode: 'main' | 'settings' = 'main') {
  const onBack = vi.fn();
  const onExpand = vi.fn();
  render(
    <MemoryRouter initialEntries={[path]}>
      <SidebarRail mode={mode} onExpand={onExpand} onBack={onBack} />
    </MemoryRouter>,
  );
  return { onBack, onExpand };
}

beforeEach(() => {
  const alpha = project('p1', 'alpha');
  const beta = project('p2', 'beta');
  state.projects = [alpha, beta, project('p3', 'x'), project('p4', 'velho', { status: 'archived' })];
  state.groups = [{ id: 'fav', name: 'Favoritos', kind: 'favorites', position: 0, project_ids: ['p2', 'p3', 'p4', 'p1'] }];
  state.items = [waitingOn(beta)];
  state.can = () => true;
});
afterEach(cleanup);

describe('SidebarRail', () => {
  it('shows the favourites in Favoritos order, two letters each, archived ones left out', () => {
    mount('/');
    const favs = within(screen.getByRole('navigation', { name: 'Favoritos' })).getAllByRole('link');
    expect(favs.map((l) => l.textContent)).toEqual(['BE', 'X', 'AL']);
    expect(favs.map((l) => l.getAttribute('href'))).toEqual(['/projects/p2', '/projects/p3', '/projects/p1']);
  });

  it('names each square after its project, and says when it needs you', () => {
    mount('/');
    const beta = screen.getByRole('link', { name: 'beta, precisa de você' });
    expect(beta).toHaveAttribute('title', 'beta, precisa de você');
    expect(beta.querySelector('[data-attention]')).not.toBeNull();
    const alpha = screen.getByRole('link', { name: 'alpha' });
    expect(alpha).toHaveAttribute('title', 'alpha');
    expect(alpha.querySelector('[data-attention]')).toBeNull();
  });

  it('highlights the project being viewed, on any of its sections', () => {
    mount('/projects/p1/tasks');
    expect(screen.getByRole('link', { name: 'alpha' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'x' })).not.toHaveAttribute('aria-current');
  });

  it('has the daily menus as icons under their permissions, and the avatar opening Perfil', () => {
    state.can = (r) => r === 'machines';
    mount('/');
    const daily = within(screen.getByRole('navigation', { name: 'Menu principal' })).getAllByRole('link');
    expect(daily.map((l) => l.getAttribute('aria-label'))).toEqual(['Máquinas']);
    expect(screen.getByRole('button', { name: 'Configurações e perfil' })).toBeInTheDocument();
  });

  it('expands', () => {
    const { onExpand } = mount('/');
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar sidebar' }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('under /settings shows the settings sections and a back button instead of the projects', () => {
    state.can = () => false;
    const { onBack } = mount('/settings/city', 'settings');
    expect(screen.queryByRole('navigation', { name: 'Favoritos' })).toBeNull();
    const sections = within(screen.getByRole('navigation', { name: 'Seções de Configurações' })).getAllByRole('link');
    expect(sections.map((l) => [l.getAttribute('aria-label'), l.getAttribute('title')])).toEqual([
      ['Perfil', 'Perfil'],
      ['Minha cidade', 'Minha cidade'],
    ]);
    expect(screen.getByRole('link', { name: 'Minha cidade' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar de Configurações' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
```

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/SidebarRail.test.tsx'; rm -rf .npm
```
Expected: FAIL — `Failed to resolve import "./SidebarRail"`.

- [ ] **Step 4: Write the rail**

Create `apps/web/src/components/SidebarRail.tsx`:
```tsx
import { ArrowLeft, ChevronsRight } from 'lucide-react';
import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { needsYouByProject } from '../lib/needs-you';
import { useProjectGroups } from '../lib/project-groups';
import { favoriteProjects } from '../lib/project-groups-model';
import { projectInitials } from '../lib/project-initials';
import { visibleSettingsSections } from '../lib/settings-sections';
import { MainNav } from './MainNav';
import { ProfileButton } from './ProfileButton';
import { SETTINGS_ICONS } from './settings-icons';

const SQUARE = 'flex h-8 w-8 shrink-0 items-center justify-center rounded';
const IDLE = 'text-fg-muted hover:bg-bg-3 hover:text-fg';

/**
 * The collapsed sidebar (spec 2026-09-23 app chrome §5), 48 px wide: logo and expand, then the
 * Favoritos projects as two-letter squares, the daily menus as icons and the avatar. Under /settings
 * it lists the settings sections as icons, with a way back, instead of the projects.
 */
export function SidebarRail({ mode, onExpand, onBack }: { mode: 'main' | 'settings'; onExpand: () => void; onBack: () => void }) {
  return (
    <aside aria-label="Sidebar recolhida" className="flex h-full w-12 shrink-0 flex-col items-center border-r border-line bg-bg-2">
      <NavLink
        to="/"
        className="flex h-11 w-full shrink-0 items-center justify-center border-b border-line text-sm font-semibold text-accent"
        title="termhub — início"
        aria-label="termhub — início"
      >
        ▮
      </NavLink>
      <button type="button" className={`mt-1 ${SQUARE} text-fg-dim hover:bg-bg-3 hover:text-fg`} onClick={onExpand} title="Mostrar sidebar" aria-label="Mostrar sidebar">
        <ChevronsRight size={18} aria-hidden="true" />
      </button>
      {mode === 'settings' ? <SettingsRail onBack={onBack} /> : <MainRail />}
    </aside>
  );
}

function MainRail() {
  const { projects } = useData();
  const { groups } = useProjectGroups();
  const { items } = useMonitor();
  const favorites = useMemo(() => favoriteProjects(projects, groups), [projects, groups]);
  const waiting = useMemo(() => needsYouByProject(items), [items]);
  return (
    <>
      <div className="mt-1 min-h-0 w-full flex-1 overflow-y-auto">
        {favorites.length > 0 && (
          <nav aria-label="Favoritos" className="flex flex-col items-center gap-1 border-t border-line py-2">
            {favorites.map((p) => {
              const needsYou = (waiting.get(p.id) ?? 0) > 0;
              const label = needsYou ? `${p.name}, precisa de você` : p.name;
              return (
                <NavLink
                  key={p.id}
                  to={`/projects/${p.id}`}
                  aria-label={label}
                  title={label}
                  className={({ isActive }) => `relative ${SQUARE} text-[11px] font-semibold ${isActive ? 'bg-accent/20 text-fg ring-1 ring-accent' : `bg-bg-3 ${IDLE}`}`}
                >
                  {projectInitials(p.name)}
                  {needsYou && <i data-attention aria-hidden="true" className="absolute right-0.5 top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-attention" />}
                </NavLink>
              );
            })}
          </nav>
        )}
      </div>
      <MainNav variant="rail" />
      <ProfileButton variant="rail" />
    </>
  );
}

function SettingsRail({ onBack }: { onBack: () => void }) {
  const { can } = useAuth();
  return (
    <>
      <button type="button" className={`mt-1 ${SQUARE} ${IDLE}`} onClick={onBack} title="Voltar (Esc)" aria-label="Voltar de Configurações">
        <ArrowLeft size={18} aria-hidden="true" />
      </button>
      <nav aria-label="Seções de Configurações" className="mt-1 flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto border-t border-line py-2">
        {visibleSettingsSections(can).map((s) => {
          const Icon = SETTINGS_ICONS[s.key];
          return (
            <NavLink key={s.key} to={`/settings/${s.key}`} aria-label={s.label} title={s.label} className={({ isActive }) => `${SQUARE} ${isActive ? 'bg-bg-4 text-fg' : IDLE}`}>
              <Icon size={18} aria-hidden="true" />
            </NavLink>
          );
        })}
      </nav>
    </>
  );
}
```

- [ ] **Step 5: Run it to verify it passes**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/SidebarRail.test.tsx'; rm -rf .npm
```
Expected: PASS (6 tests).

- [ ] **Step 6: Use the rail in the layout (test first)**

In `apps/web/src/components/Layout.test.tsx` add after the `./SettingsSidebar` mock:
```tsx
vi.mock('./SidebarRail', () => ({
  SidebarRail: ({ mode, onBack }: { mode: string; onBack: () => void }) => <button onClick={onBack}>{`rail-${mode}`}</button>,
}));
```
and append inside `describe('Chrome', …)`:
```tsx
  it('collapsed, shows the rail with the projects outside settings', () => {
    mount('/machines', true);
    expect(screen.getByText('rail-main')).toBeTruthy();
    expect(screen.queryByText('projects-sidebar')).toBeNull();
  });

  it('collapsed under /settings, shows the settings rail wired to the way back', () => {
    const leave = mount('/settings/users', true);
    fireEvent.click(screen.getByText('rail-settings'));
    expect(leave).toHaveBeenCalledTimes(1);
  });
```
Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/Layout.test.tsx'; rm -rf .npm
```
Expected: FAIL — the collapsed branch still renders the old internal strip (no `rail-main`).

In `apps/web/src/components/Layout.tsx`:
- change `import { Navigate, NavLink, Outlet, useLocation } from 'react-router-dom';` to `import { Navigate, Outlet, useLocation } from 'react-router-dom';`
- add `import { SidebarRail } from './SidebarRail';` after `import { SettingsSidebar } from './SettingsSidebar';`
- replace in `Chrome`:
  ```tsx
  if (collapsed) return <SidebarRail onExpand={() => setCollapsed(false)} />;
  if (isSettingsPath(pathname)) return <SettingsSidebar onBack={onLeaveSettings} onCollapse={() => setCollapsed(true)} />;
  ```
  with:
  ```tsx
  const settings = isSettingsPath(pathname);
  if (collapsed) return <SidebarRail mode={settings ? 'settings' : 'main'} onExpand={() => setCollapsed(false)} onBack={onLeaveSettings} />;
  if (settings) return <SettingsSidebar onBack={onLeaveSettings} onCollapse={() => setCollapsed(true)} />;
  ```
- delete the whole internal `/** Sidebar recolhida: … */ function SidebarRail(…) { … }` block.

- [ ] **Step 7: Run the tests and the gate**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/components/Layout.test.tsx'; rm -rf .npm
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/web && npm run build:city -w @termhub/web && CI=1 npm test -w @termhub/web'; rm -rf .npm
```
Expected: Layout 5 tests PASS; typecheck clean; all web tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/project-initials.ts apps/web/src/lib/project-initials.test.ts apps/web/src/lib/project-groups-model.ts apps/web/src/lib/project-groups-model.test.ts apps/web/src/components/SidebarRail.tsx apps/web/src/components/SidebarRail.test.tsx apps/web/src/components/Layout.tsx apps/web/src/components/Layout.test.tsx
git commit -m "Web: collapsed sidebar rail with Favoritos, menus and avatar

Favourite projects show as two-letter squares with the attention dot;
under /settings the rail lists the settings sections instead.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: PageHeader in Máquinas, Início, Escritório and the project page

**Files:**
- Modify: `apps/web/src/pages/MachinesPage.tsx:1-28,156`, `apps/web/src/pages/MachinesPage.test.tsx`
- Modify: `apps/web/src/pages/HomePage.tsx:1-43,75`
- Modify: `apps/web/src/components/AiAccountsView.tsx:284`, `apps/web/src/components/HardwareView.tsx:135`, `apps/web/src/components/WaitlistView.tsx:190` (their `h1` becomes an `h2`: they are Home tabs now under Home's header)
- Test: `apps/web/src/pages/HomePage.test.tsx` (new)
- Modify: `apps/web/src/pages/OfficePage.tsx:1-12,251-263`, `apps/web/src/pages/OfficePage.test.tsx`
- Modify: `apps/web/src/pages/ProjectPage.tsx` (whole file), `apps/web/src/pages/ProjectPage.test.tsx`

**Interfaces:**
- Consumes: `PageHeader`, `PageFrame`, `PageHeaderTab` (Task 1).
- Produces: nothing new; every page inside the sidebar layout has exactly one `h1`, inside its `<header>`.

- [ ] **Step 1: Write the failing page tests**

In `apps/web/src/pages/MachinesPage.test.tsx` append inside `describe('MachinesPage', …)`:
```tsx
  it('uses the shared page header: one title, "+ máquina" among its actions', () => {
    mount();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Máquinas']);
    expect(screen.getByRole('button', { name: '+ máquina' }).closest('header')).not.toBeNull();
  });
```

Create `apps/web/src/pages/HomePage.test.tsx`:
```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/auth', () => ({ useAuth: () => ({ can: (r: string) => r !== 'waitlist' }) }));
vi.mock('../lib/data', () => ({ useData: () => ({ statuses: {}, projects: [] }) }));
vi.mock('../lib/api', () => ({ api: { dashboard: () => new Promise(() => {}) } }));
vi.mock('../components/NeedsYouList', () => ({ NeedsYouList: () => null }));
vi.mock('../components/ProjectCards', () => ({ ProjectCards: () => null }));
vi.mock('../components/AiAccountsView', () => ({ AiAccountsView: () => <p>ai-view</p> }));
vi.mock('../components/HardwareView', () => ({ HardwareView: () => <p>hardware-view</p> }));
vi.mock('../components/WaitlistView', () => ({ WaitlistView: () => <p>waitlist-view</p> }));

import { HomePage } from './HomePage';

function mount(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="*" element={<HomePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

describe('HomePage', () => {
  it('uses the shared page header with its tabs, under their permissions', () => {
    mount('/');
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Início']);
    const tabs = within(screen.getByRole('navigation', { name: 'Seções de Início' })).getAllByRole('link');
    expect(tabs.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Projetos', '/'],
      ['Contas de IA', '/ai'],
      ['Hardware', '/hardware'],
    ]);
    expect(screen.getByRole('heading', { level: 2, name: 'O que estou fazendo' })).toBeInTheDocument();
  });

  it('marks and opens the current tab', () => {
    mount('/ai');
    expect(screen.getByRole('link', { name: 'Contas de IA' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Projetos' })).not.toHaveAttribute('aria-current');
    expect(screen.getByText('ai-view')).toBeInTheDocument();
  });
});
```

In `apps/web/src/pages/OfficePage.test.tsx` add at the end of the file:
```tsx
describe('OfficePage header', () => {
  it('is the shared page header: Escritório as the only title, the trail and the actions in it', async () => {
    officeMock.mockReturnValue(new Promise(() => {}));
    dataState.current = { ...dataState.current, loading: false };
    renderPage('/office');
    await act(async () => {});
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Escritório']);
    const header = screen.getByRole('heading', { level: 1 }).closest('header')!;
    expect(header.contains(screen.getByLabelText('Trilha'))).toBe(true);
    expect(header.contains(screen.getByText('modo foco'))).toBe(true);
  });
});
```

In `apps/web/src/pages/ProjectPage.test.tsx` change the first import to:
```tsx
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
```
and add at the end of the file:
```tsx
describe('ProjectPage header', () => {
  it('is the shared page header: the name as the only title, its sections as tabs, publish among the actions', () => {
    const proj = project({ open_tasks: 3 });
    dataState.current = { ...dataState.current, projects: [proj] };
    renderPage(proj);
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['meu-projeto']);
    expect(screen.getByText('MEU · jarvis')).toBeTruthy();
    const tabs = screen.getByRole('navigation', { name: 'Seções de meu-projeto' });
    expect(within(tabs).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '/projects/p1',
      '/projects/p1/tasks',
      '/projects/p1/tickets',
      '/projects/p1/notes',
      '/projects/p1/settings',
    ]);
    expect(within(tabs).getByRole('link', { name: /Tarefas/ }).textContent).toBe('Tarefas3');
    expect(within(tabs).getByRole('link', { name: 'Terminais' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('switch', { name: /publicar/i }).closest('header')).not.toBeNull();
  });
});
```

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/pages/MachinesPage.test.tsx src/pages/HomePage.test.tsx src/pages/OfficePage.test.tsx src/pages/ProjectPage.test.tsx'; rm -rf .npm
```
Expected: FAIL — Máquinas has no `<header>`; Home has no `h1`/"Seções de Início" nav and "O que estou fazendo" is an `h1`; Escritório is a `span`; the project page has no `h1` nor "Seções de meu-projeto" nav.

- [ ] **Step 2: Máquinas**

In `apps/web/src/pages/MachinesPage.tsx` add `import { PageFrame } from '../components/PageHeader';` after `import { ConfirmDialog } from '../components/Modal';`, then replace:
```tsx
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-5 flex items-center gap-3">
        <h1 className="text-lg font-semibold">Máquinas</h1>
        {can('machines', 'create') && (
          <button className="btn-primary ml-auto" onClick={() => setForm({ open: true, machine: null })}>
            + máquina
          </button>
        )}
      </div>
```
with:
```tsx
  return (
    <PageFrame
      title="Máquinas"
      actions={
        can('machines', 'create') && (
          <button className="btn-primary text-xs" onClick={() => setForm({ open: true, machine: null })}>
            + máquina
          </button>
        )
      }
    >
```
and the file's last lines:
```tsx
      />
    </div>
  );
}
```
with:
```tsx
      />
    </PageFrame>
  );
}
```

- [ ] **Step 3: Início**

In `apps/web/src/pages/HomePage.tsx` replace lines 1-43 (imports, `TABS`, `HomePage`) with:
```tsx
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api';
import { useData } from '../lib/data';
import { useAuth } from '../lib/auth';
import type { DashboardItem } from '../lib/types';
import { AiAccountsView } from '../components/AiAccountsView';
import { HardwareView } from '../components/HardwareView';
import { WaitlistView } from '../components/WaitlistView';
import { NeedsYouList } from '../components/NeedsYouList';
import { ProjectCards } from '../components/ProjectCards';
import { PageFrame } from '../components/PageHeader';

/** Home tabs; each one is shown only when the user's role grants its resource. */
const TABS: { path: string; label: string; resource: string }[] = [
  { path: '/', label: 'Projetos', resource: 'projects' },
  { path: '/ai', label: 'Contas de IA', resource: 'ai_accounts' },
  { path: '/hardware', label: 'Hardware', resource: 'hardware' },
  { path: '/waitlist', label: 'Waitlist', resource: 'waitlist' },
];

export function HomePage() {
  const { pathname } = useLocation();
  const { can } = useAuth();
  const tabs = TABS.filter((t) => t.resource === 'projects' || can(t.resource));
  const allowed = tabs.some((t) => t.path === pathname);
  return (
    <PageFrame title="Início" tabs={tabs.map((t) => ({ to: t.path, label: t.label, end: true }))}>
      {!allowed ? <p className="text-sm text-fg-dim">Sem permissão para esta aba.</p> : pathname === '/ai' ? <AiAccountsView /> : pathname === '/hardware' ? <HardwareView /> : pathname === '/waitlist' ? <WaitlistView /> : <Dashboard />}
    </PageFrame>
  );
}
```
and in `Dashboard` replace:
```tsx
          <h1 className="text-lg font-semibold">O que estou fazendo</h1>
```
with:
```tsx
          <h2 className="text-lg font-semibold">O que estou fazendo</h2>
```

The other Home tabs sit under the same header now, so their titles become section headings too:
- `apps/web/src/components/AiAccountsView.tsx:284` — `<h1 className="text-lg font-semibold">Contas de IA</h1>` → `<h2 className="text-lg font-semibold">Contas de IA</h2>`
- `apps/web/src/components/HardwareView.tsx:135` — `<h1 className="text-lg font-semibold">Hardware</h1>` → `<h2 className="text-lg font-semibold">Hardware</h2>`
- `apps/web/src/components/WaitlistView.tsx:190` — `<h1 className="text-lg font-semibold">Waitlist do Cloud</h1>` → `<h2 className="text-lg font-semibold">Waitlist do Cloud</h2>`

- [ ] **Step 4: Escritório**

In `apps/web/src/pages/OfficePage.tsx` add `import { PageHeader } from '../components/PageHeader';` after the `import type { Machine, OfficeRoom } from '../lib/types';` line, then replace:
```tsx
      {!focus && (
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-bg-2 px-3 py-2 text-xs text-fg-muted">
          <span className="text-sm font-semibold text-fg">Escritório</span>
          <Trail parts={trail} />
          <span className="ml-auto flex items-center gap-3">
            <StatusNotices machine={here} connected={connected} />
            <ShareButton result={shareResult} />
            <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => setFocus(true)} title="Modo foco (F)">
              modo foco
            </button>
          </span>
        </div>
      )}
```
with:
```tsx
      {!focus && (
        <PageHeader
          title="Escritório"
          extra={<Trail parts={trail} />}
          actions={
            <span className="flex items-center gap-3 text-xs text-fg-muted">
              <StatusNotices machine={here} connected={connected} />
              <ShareButton result={shareResult} />
              <button className="rounded px-2 py-1 hover:bg-bg-3 hover:text-fg" onClick={() => setFocus(true)} title="Modo foco (F)">
                modo foco
              </button>
            </span>
          }
        />
      )}
```

- [ ] **Step 5: The project page**

Replace `apps/web/src/pages/ProjectPage.tsx` with:
```tsx
import { useParams } from 'react-router-dom';
import { useData } from '../lib/data';
import { PROJECT_STATUS_LABEL } from '../lib/types';
import { TerminalsView } from '../components/TerminalsView';
import { TasksBoard } from '../components/TasksBoard';
import { NotesEditor } from '../components/NotesEditor';
import { TicketsView } from '../components/TicketsView';
import { ProjectSettings } from '../components/ProjectSettings';
import { PublishControl } from '../components/PublishControl';
import { FullScreenMessage } from '../components/Layout';
import { PageHeader } from '../components/PageHeader';

export type ProjectSection = 'terminals' | 'tasks' | 'tickets' | 'notes' | 'settings';

const SECTIONS: { key: ProjectSection; label: string; path: string }[] = [
  { key: 'terminals', label: 'Terminais', path: '' },
  { key: 'tasks', label: 'Tarefas', path: 'tasks' },
  { key: 'tickets', label: 'Tickets', path: 'tickets' },
  { key: 'notes', label: 'Notas', path: 'notes' },
  { key: 'settings', label: 'Setup', path: 'settings' },
];

export function ProjectPage() {
  const { id, section } = useParams<{ id: string; section?: string }>();
  const { projects, machinesOf, statuses, loading } = useData();
  const project = projects.find((p) => p.id === id);
  const current: ProjectSection = SECTIONS.find((s) => s.path === (section ?? ''))?.key ?? 'terminals';

  if (loading) return <FullScreenMessage>Carregando…</FullScreenMessage>;
  if (!project) return <FullScreenMessage>Projeto não encontrado.</FullScreenMessage>;
  const projectMachines = machinesOf(project);
  const online = projectMachines.some((m) => statuses[m.id] === 'online');
  const status =
    projectMachines.length === 0
      ? null
      : online
        ? 'online'
        : projectMachines.every((m) => statuses[m.id] === 'offline')
          ? 'offline'
          : 'checking';

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={project.name}
        subtitle={`${project.key} · ${projectMachines.length === 0 ? 'sem máquina' : projectMachines.map((m) => m.name).join(', ')}`}
        tabs={SECTIONS.map((s) => ({
          to: `/projects/${project.id}${s.path ? '/' + s.path : ''}`,
          label: s.label,
          end: true,
          badge: s.key === 'tasks' ? project.open_tasks : undefined,
        }))}
        actions={
          <>
            {project.status !== 'active' && <span className="rounded bg-bg-4 px-1.5 text-[10px] text-fg-muted">{PROJECT_STATUS_LABEL[project.status]}</span>}
            {status && (
              <span
                className={`h-2 w-2 shrink-0 rounded-full ${status === 'online' ? 'bg-ok' : status === 'offline' ? 'bg-danger' : 'bg-warn animate-pulse'}`}
                title={status}
              />
            )}
            <PublishControl project={project} />
          </>
        }
      />
      <div className="relative min-h-0 flex-1">
        {/* Terminais ficam montados mesmo em outras seções: trocar de aba não reconecta. */}
        <TerminalsView key={`terminals-${project.id}`} project={project} visible={current === 'terminals'} />
        {current === 'tasks' && <TasksBoard key={`tasks-${project.id}`} projectId={project.id} />}
        {current === 'tickets' && <TicketsView key={`tickets-${project.id}`} project={project} />}
        {current === 'notes' && <NotesEditor key={`notes-${project.id}`} projectId={project.id} />}
        {current === 'settings' && (
          // Keyed without `machines`: a link/unlink/cwd-save must not remount this whole subtree —
          // it would wipe the "N tabs fechadas" notice, a row's "Salvo." message and unsaved
          // SetupForm edits. ProjectMachines re-keys its own rows to pick up a saved cwd instead.
          <ProjectSettings key={`settings-${project.id}-${project.status}-${project.name}`} project={project} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run the page tests**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm test -w @termhub/web -- src/pages/MachinesPage.test.tsx src/pages/HomePage.test.tsx src/pages/OfficePage.test.tsx src/pages/ProjectPage.test.tsx'; rm -rf .npm
```
Expected: PASS — the new header tests and every pre-existing test in those files (Office's `Trilha`/`modo foco`/focus-mode tests, the project publish-switch tests).

- [ ] **Step 7: Confirm no page keeps its own title bar**

Run:
```bash
grep -rn '<h1' apps/web/src --include=*.tsx | grep -v test | grep -v PageHeader.tsx
```
Expected: only `apps/web/src/pages/LoginPage.tsx` and `apps/web/src/components/ChatLayout.tsx` (both outside the sidebar layout, out of scope) appear; nothing under `pages/{Home,Machines,Office,Project,Settings}Page.tsx`, `components/{IntegrationsView,MyCityView,AiAccountsView,HardwareView,WaitlistView}.tsx`.

- [ ] **Step 8: Run the web gate**

Run:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/web && npm run build:city -w @termhub/web && CI=1 npm test -w @termhub/web'; rm -rf .npm
```
Expected: typecheck clean (no unused `NavLink` in Home/Project); all web tests pass.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/pages/MachinesPage.tsx apps/web/src/pages/MachinesPage.test.tsx apps/web/src/pages/HomePage.tsx apps/web/src/pages/HomePage.test.tsx apps/web/src/components/AiAccountsView.tsx apps/web/src/components/HardwareView.tsx apps/web/src/components/WaitlistView.tsx apps/web/src/pages/OfficePage.tsx apps/web/src/pages/OfficePage.test.tsx apps/web/src/pages/ProjectPage.tsx apps/web/src/pages/ProjectPage.test.tsx
git commit -m "Web: shared page header on Máquinas, Início, Escritório and projects

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (no commit)

- [ ] Run CLAUDE.md's pre-push check plus the full web suite:
```bash
docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/w" -w /w node:20 sh -c 'npm run typecheck -w @termhub/server && npm run build -w @termhub/web && npm run build -w @termhub/landing && npm run build:city -w @termhub/web && CI=1 npm test -w @termhub/web'; rm -rf .npm
```
Expected: exits 0.
- [ ] Confirm the public bundle stayed clean: `grep -rln lucide apps/web/src/city apps/web/src/office` prints nothing.
- [ ] `git status --short` is empty (no stray `.npm`, `dist`, `dist-city` tracked).

## Self-review notes

- Spec coverage: §2 icons → Tasks 2, 4, 5, 6 (every listed icon is used: `User`, `Map`, `Plug`, `KeyRound`, `Users`, `Shield`, `ListChecks`, `Folder` in `settings-icons.ts`; `Building2`, `MessageSquare`, `Monitor` in `MainNav`; `Settings` in `ProfileButton`; `LogOut` in `ProfileView`; `ChevronsLeft` in `Sidebar`/`SettingsSidebar`; `ChevronsRight`, `ArrowLeft` in `SidebarRail`/`SettingsSidebar`). §3 → Task 5. §4 sidebar/back/Esc/slide → Task 4; content without tab row, `/settings`→profile, `/integrations` redirect → Task 3. §4.1 → Task 2. §5 → Task 6. §6 → Tasks 1, 3, 7. §7 → Tasks 4 (ref in layout; `localStorage` key untouched), focus mode kept in `Chrome`. §8 → the tests listed in each task.
- Deliberate choices where the spec is silent: the settings rail shows logo, expand, back and the section icons (no daily icons or avatar, which would lead out of settings a second way); `SettingsSidebar` also carries the collapse button so the collapsed flag can be changed from settings; Home's header title is "Início" (Home has no title today); the project page's sections become header tabs, its key and machines the subtitle, status badge + online dot + publish switch the actions (the cwd tooltip on the machine names is dropped); "+ role" moves into the Roles header like "Convidar"; "Novo token" and Arquivos' "Atualizar" stay inside their standalone views.
