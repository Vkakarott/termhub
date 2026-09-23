# App chrome — one page header, a settings sidebar, a useful rail — design

Date: 2026-09-23. Status: **approved design, not implemented.**

## 1. Goal

The signed-in app looks assembled page by page: Máquinas and Integrações put a large title in the
content, Escritório a thin bar with a "Cidade" link, Configurações a row of tabs, Home and the project
page an `h-11` bar. The sidebar mixes emoji menus, a "Ver como…" switch and a profile row with
"Cookies"/"Sair". Collapsed, it is an empty strip.

After this change:

- Every page has the same header (`PageHeader`).
- Configurações is a **sidebar** that slides over the projects sidebar, listing its sections
  vertically; the profile row at the bottom of the sidebar is its entry point and opens **Perfil**.
- The daily menus — Escritório, Chat, Máquinas — stay in the main sidebar with line icons;
  Integrações moves into Configurações; "Ver como…", "Cookies" and "Sair" move into Perfil.
- Collapsed, the sidebar becomes a **rail** with the Favoritos projects (two letters, attention dot),
  the daily menus as icons and the avatar.

Out of scope: restyling page contents (tables, forms, cards), the chat's full-screen layout
(`ChatLayout`), the public city page, the login page.

## 2. Icons

Adopt `lucide-react` (MIT, tree-shaken) for chrome icons: `Building2` Escritório, `MessageSquare`
Chat, `Monitor` Máquinas, `Settings` engrenagem, `User` Perfil, `Map` Minha cidade, `Plug`
Integrações, `KeyRound` Tokens de API, `Users` Usuários, `Shield` Roles, `ListChecks` Permissões,
`Folder` Arquivos, `LogOut` Sair, `ChevronsLeft`/`ChevronsRight` recolher/expandir, `ArrowLeft`
voltar. Size 16 in the open sidebar, 18 in the rail; colour `currentColor`. Emoji menus go away.
The public city bundle must not import it (it would not anyway: the rule allows only `office/**`
and `lib/types.ts`).

## 3. Main sidebar (open)

Unchanged: the top row (termhub, "+ novo", collapse) and the projects area (Em execução, Favoritos,
groups, Outros).

Changed, bottom to top:

- **Profile row** (`ProfileButton`): avatar + name + a `Settings` icon, the whole row one button
  (`aria-label="Configurações e perfil"`) that navigates to `/settings/profile`.
- **Daily menus** (`MainNav`), above the profile row: Escritório (attention dot when `needsYou`
  is non-empty, as today), Chat, Máquinas — each `NavLink` with icon + label, shown under today's
  permission checks (`projects`+`terminals` read, `chat`, `machines`).
- Removed from the sidebar: `ViewAsSwitch`, the Integrações and Configurações links, "Cookies",
  "Sair".

## 4. Settings sidebar

When the location is under `/settings`, the sidebar slot renders `SettingsSidebar` instead of the
projects `Sidebar`, entering with a short slide (150 ms `transform`, disabled under
`prefers-reduced-motion`).

- Header: a back button (`ArrowLeft` + "Configurações") that navigates to the last location outside
  `/settings` (remembered in memory by the layout; `/` when there is none). Esc does the same when
  focus is not in a text field or a dialog.
- Sections (from `SETTINGS_SECTIONS`, extended), vertical `NavLink`s with icons, grouped:
  - **Conta**: Perfil (`profile`), Minha cidade (`city`), Integrações (`integrations`,
    resource `integrations`), Tokens de API (`api-tokens`, resource `api_tokens`).
  - **Administração** (heading shown only if any item is visible): Usuários, Roles, Permissões,
    Arquivos — each under its current resource.
- The settings page content keeps its sections' components; the top tab row is removed.
- `/settings` with no section opens `profile` (everyone can see it). Admins no longer land on
  Usuários — they get there from the list.
- Routes: `/integrations` redirects to `/settings/integrations` (keeps bookmarks and links working);
  `IntegrationsPage`'s content renders as the `integrations` section.

### 4.1 Perfil

New section `ProfileView`: avatar, name, e-mail; for admins, the **Ver como…** switch (the existing
`ViewAsSwitch`, moved); "Preferências de cookies" when `ANALYTICS_ENABLED`; **Sair** (logs out and
goes to `/login`, as today).

## 5. Rail (collapsed sidebar)

`SidebarRail`, 48 px wide, replaces today's empty strip:

1. Logo (link to `/`) and the expand button (`ChevronsRight`).
2. **Favoritos**: one square per favourite project (same order as the Favoritos section), showing
   the first two letters of the project's **name** (uppercase; for a one-letter name, that letter),
   an attention dot when any of its tabs needs you (`needsYouByProject`), a tooltip and
   `aria-label` with the project's name (+ ", precisa de você"), linking to the project. The active
   project's square is highlighted. The list scrolls if it overflows.
3. The daily menus as icon buttons (same routes, permissions and Escritório dot), tooltip = label.
4. The avatar at the bottom → `/settings/profile`.

Under `/settings`, the rail shows the settings sections as icons (tooltips) and a back button,
instead of the projects.

## 6. PageHeader

`components/PageHeader.tsx`, used by every page inside the sidebar layout:

```
<PageHeader title="Máquinas" subtitle?="…" tabs?={[{ to, label }]} actions?={<button/>} />
```

- One bar: `h-11`, `bg-bg-2`, `border-b border-line`, `px-4`, title `text-sm font-semibold`,
  subtitle `text-xs text-fg-muted` next to it (truncated), tabs as `NavLink`s after the title
  (same style as Home's today), actions right-aligned.
- Adopters: Máquinas, Integrações (as a settings section), every settings section (title = the
  section's label; "Convidar" and "+ integração" move into `actions`), Minha cidade, Escritório
  (title "Escritório", the city link as a tab/action), Home (its current tabs), the project page
  (its current header content fits: title + actions).
- Long explanatory subtitles that do not fit (Usuários, Integrações) move to a paragraph at the top
  of the content, not the header.

## 7. Layout state

- The collapsed flag stays in `localStorage` (`termhub:sidebar-collapsed`, as today).
- "Last location outside settings" lives in the layout (a ref updated on location change).
- Focus mode (`/office` focus) still hides all chrome.

## 8. Testing

- `ProfileButton` → `/settings/profile`; `MainNav` items by permission, Escritório dot.
- `SettingsSidebar`: grouped sections by permission (a user with no admin grants sees only Conta),
  back button and Esc return to the last non-settings location (`/` without one), Esc ignored in a
  text field.
- `/settings` → Perfil; `/integrations` → `/settings/integrations`.
- `ProfileView`: Ver como only for admins; Sair logs out; Cookies only with analytics.
- `SidebarRail`: favourites with two letters, attention dot and accessible name, active highlight;
  daily icons by permission; under `/settings` shows settings icons.
- `PageHeader`: title/subtitle/tabs/actions render; each adopting page shows exactly one header
  (no page keeps its own `h1` bar).
- Existing Sidebar/Settings/Machines/Office/Project tests updated for the moves.
