# Themes (UI palettes and terminal settings)

> Status: **implemented**. Verified by code, unit tests and in the browser (web, light/dark
> palettes). WebGL, Electron and TUI were not run (see §8). This document records the decisions
> taken at implementation and what was deliberately not done.
>
> Code landmarks: `packages/ui/src/useTheme.ts`, `packages/ui/src/store/index.ts`,
> `packages/ui/src/styles.css`, `packages/ui/src/terminal/TerminalSession.tsx`,
> `apps/zcode-cli/packages/tui/src/theme/defaults.ts`. Search by symbol; line numbers are
> approximate.

## 0. How to work on this spec

- Order: spec → palettes (state and CSS) → palette picker in settings → WebGL → i18n → CLI →
  verification.
- After each iteration: `pnpm typecheck`, `pnpm lint` (0 errors in changed files; pre-existing CLI
  `max-lines` do not count), `npx oxfmt --check <changed files>` (not the repo `pnpm fmt`),
  `pnpm architecture:check --changed`.
- Decisions not in the table below are aligned with the user, not chosen unilaterally.

## 1. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Palette and mode are two independent choices. Mode: `light` / `dark` / `system`. Palette: `neutral`, `zai` and 8 accent palettes.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D2  | **Unconfirmed.** The CLI stores `ui.theme` in its own config (`~/.zcode/config.json`, `apps/zcode-cli/packages/contracts/src/config/index.ts:79,300`). Desktop does not pass the theme to the CLI (no `ui.theme`/`--theme` in `packages/`). Therefore the CLI gets a **separate** `ui.palette` key and does not sync with desktop. No desktop→CLI bridge. The question to the user went unanswered; the decision was made unilaterally and needs confirmation before merge.                                                                            |
| D3  | Desktop/web storage follows the existing theme: localStorage + broadcast between windows (`BROADCAST_FIELDS`). No server record: the CLI does not read the desktop theme, and cross-device sync was not requested.                                                                                                                                                                                                                                                                                                                                     |
| D4  | The xterm WebGL renderer is a terminal setting, **off** by default. On activation failure the addon is explicitly released (`dispose()`) and the terminal stays on DOM. On WebGL context loss it falls back to DOM without crashing. The flag is read via `useZCodeStoreWithDefault(…, false)`: without a `StoreProvider` it silently reads as "off". The browser limit on simultaneous WebGL contexts was not checked.                                                                                                                                |
| D5  | The palette list is fixed. Palettes are not loaded externally and cannot be added by the user.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D6  | An accent palette overrides `--color-brand`, `--color-accent`, `--color-primary`, `--color-primary-foreground`, plus `--color-ring` in the light block. Without `--color-primary`, buttons, switches, checkboxes and badges (~56 `bg-primary` uses) do not change and the palette choice is nearly invisible. **Decided unilaterally** while the user was unavailable; needs confirmation.                                                                                                                                                             |
| D7  | Surfaces (background, sidebar, header, panels, cards, popovers, inputs) are tinted with the palette accent (see §2). The visible sidebar on web/Windows/Linux is `--color-background-win-alt`; on macOS it is `--color-background-alt` (vibrancy), which is expressed through win-alt. Both are tinted. Text and selections (`--color-selected`, `--color-hover`) do not change. **Accepted on the user's direct request** ("я думал что будет менятся и фон и т.д." — expected the background to change too); the tint intensity needs visual review. |

## 2. Palettes

- `neutral` — the base `:root` / `.dark` tokens without a palette. Migration never maps to it: old
  values map to `zai` (see §4).
- `zai` — the full skin: the `theme-zai-light` / `theme-zai-dark` classes are set only for it. All
  old values (`light`, `dark`, `system`, `zai-*`) migrate to `zai`; it is also the default.
- `ocean`, `forest`, `ember`, `violet`, `slate`, `rose`, `sand`, `mint` — override `--color-brand`,
  `--color-accent`, `--color-primary` and `--color-primary-foreground` (D6). `--color-accent` =
  `color-mix(in oklab, <hex> 12%, transparent)` in light and 16% in dark. The light block also sets
  `--color-ring: var(--color-primary)`. Surfaces (D7) are tinted with the accent in OKLab; values
  are written as ready hex: `--color-background` — 10% over `#fafafa` (light) and 12% over `#171717`
  (dark); `--color-sidebar` — 22% over `#f5f5f5` (light) and 10% over `#0a0a0a` (dark);
  `--color-card`, `--color-popover`, `--color-input` — 5% over `#ffffff` (light) and 9% over
  `#262626` (dark). The visible sidebar on web, Windows and Linux is painted by the window's root
  element (`DesktopWindowFrame.tsx:43`) via `--color-background-win-alt`; components do not read
  `--color-sidebar`. So win-alt is tinted separately: 12% over `#e5e5e5` (light) and 12% over
  `#262626` (dark); values in the table below. The light sidebar is darker than the background
  (ratio ≈ 1.22–1.23), the dark one lighter (≈ 1.20–1.24). `--color-background-alt` (macOS with
  vibrancy, and the collapsed rail `WorkspaceSidebarCollapsedRail.tsx`) is set explicitly by every
  palette block: `color-mix(in oklab, var(--color-background-win-alt) 60%, transparent)`, the same
  formula as `.theme-zai-dark`. Without this the palette did not change the macOS sidebar.
  `--color-header` and `--color-panel` follow sidebar in light and background in dark, as the base
  tokens do. Text (`--color-foreground`) does not change. `--color-primary-foreground`: `#fafafa`
  in light and `#0a0a0a` in dark.

Accent colors (light / dark), the same for `--color-brand` and `--color-primary` in each mode:

| Palette | light     | dark      |
| ------- | --------- | --------- |
| ocean   | `#2563eb` | `#60a5fa` |
| forest  | `#15803d` | `#4ade80` |
| ember   | `#c2410c` | `#fb923c` |
| violet  | `#7c3aed` | `#a78bfa` |
| slate   | `#475569` | `#94a3b8` |
| rose    | `#be185d` | `#f472b6` |
| sand    | `#a16207` | `#facc15` |
| mint    | `#0f766e` | `#2dd4bf` |

Surfaces (D7): background / sidebar / card. `--color-header` and `--color-panel` match sidebar in
light and background in dark. Values cross-checked with `styles.css`.

| Palette | light bg  | light sidebar | light card | dark bg   | dark sidebar | dark card |
| ------- | --------- | ------------- | ---------- | --------- | ------------ | --------- |
| ocean   | `#e4ecfb` | `#c6d7f7`     | `#f4f8ff`  | `#20262e` | `#12171d`    | `#2c3037` |
| forest  | `#e5eee6` | `#c8dbcb`     | `#f4f9f5`  | `#202b23` | `#121b14`    | `#2c342e` |
| ember   | `#f7e8e3` | `#efcfc5`     | `#fdf6f3`  | `#2e241e` | `#1d1610`    | `#372f2a` |
| violet  | `#ece9fb` | `#d7d0f7`     | `#f7f6ff`  | `#25242e` | `#16151d`    | `#302f37` |
| slate   | `#e7e8eb` | `#cccfd5`     | `#f5f6f7`  | `#242527` | `#151618`    | `#2f3031` |
| rose    | `#f7e6e9` | `#efcad1`     | `#fef5f6`  | `#2e2227` | `#1d1318`    | `#372d31` |
| sand    | `#f2eae4` | `#e4d4c5`     | `#fbf7f3`  | `#2d291e` | `#1d1a11`    | `#36332a` |
| mint    | `#e4eceb` | `#c7d8d6`     | `#f4f8f7`  | `#1f2a28` | `#111a18`    | `#2b3432` |

Sidebar (`--color-background-win-alt`):

| Palette | light     | dark      |
| ------- | --------- | --------- |
| ocean   | `#ced7e8` | `#2d343c` |
| forest  | `#ced9d0` | `#2e3930` |
| ember   | `#e4d2cd` | `#3d322b` |
| violet  | `#d6d3e9` | `#33313c` |
| slate   | `#d1d3d5` | `#323335` |
| rose    | `#e4cfd4` | `#3c2f35` |
| sand    | `#ded5cd` | `#3c382c` |
| mint    | `#ced7d6` | `#2d3836` |

Text-on-surface contrast: ≥ 4.5:1 against `#404040` (light) and `#e5e5e5` (dark) for all eight
surface tokens, including `--color-background-win-alt`. Checked by the same test.

Accent-color contrast is checked by `packages/ui/test/themeContrast.test.ts`: at least 3:1 for UI
elements against approximate backgrounds `#fafafa` / `#171717`, not against the rendered surfaces.
The same test cross-checks the hex values in `styles.css` against the registry.
`--color-primary-foreground` is checked for ≥ 4.5:1 against primary in both modes.

## 3. State owner

- `packages/ui/src/useTheme.ts` — types `Theme` (`light` / `dark` / `system`), `ResolvedTheme`,
  `ThemeSelection`; `migrateThemeSelection`, `readStoredThemeSelection`,
  `applyTheme(mode, palette = DEFAULT_THEME_PALETTE)`. `applyTheme` sets classes on `<html>`: `dark`,
  `theme-zai-*` (only for `zai`) or `palette-<id>` (only for accents). The `useTheme` hook is
  removed; only types are exported from `@zcode/ui`.
- `packages/ui/src/lib/themePalettes.ts` — the pure palette registry: ids and accent hex for
  light/dark (UI i18n labels are built from the key `settings.themePalette.<id>`). No IO.
- `packages/ui/src/styles.css` (blocks around lines 749–870; each light block sets `--color-ring`) —
  `.palette-<id>` (light) and `.palette-<id>.dark` (dark). `.palette-<id>.dark` (0,2,0) is more
  specific than `.palette-<id>` (0,1,0), so the dark variant overrides the light one. The blocks
  come after the base themes, so they override `:root` and `.dark`.
- `packages/ui/src/store/index.ts` — `theme` and `palette` in zustand; `palette` is in
  `BROADCAST_FIELDS`. Incoming broadcast is normalized through `migrateThemeSelection` and
  `isThemePalette`; echo is suppressed by the `applyingBroadcast` flag.
- `packages/ui/src/store/systemThemeSync.ts` — the `prefers-color-scheme` listener
  (`createSystemThemeSync`). Re-applies the theme only in `system` mode. Lives outside the store due
  to the 400-line limit.
- `packages/desktop/src/renderer/src/main.tsx`, `resource-manager.tsx` — bootstrap through
  `migrateThemeSelection` and `applyTheme`.
- `packages/web/src/main.tsx` — calls `applyTheme` and `readStoredThemeSelection`.
  `packages/web/index.html` (inline-bootstrap) duplicates the class logic because it cannot import
  `@zcode/ui`. Changes to `applyTheme` must be mirrored in `index.html` manually.
- `terminalWebglEnabled` — in the store, localStorage `zcode-terminal-webgl`. The flag is local and
  not in `BROADCAST_FIELDS`. Addon wiring: `packages/ui/src/terminal/terminalWebglRenderer.ts`.

## 4. Migration

- `zcode-theme`: `light` → (`zai`, `light`); `dark` → (`zai`, `dark`); `system` → (`zai`, `system`);
  `zai-light` → (`zai`, `light`); `zai-dark` → (`zai`, `dark`); empty or unknown → (`zai`, `dark`).
- All old values migrate to `zai`, because HEAD already rendered them as zai. In
  `git show HEAD:packages/ui/src/useTheme.ts` the function `normalizeThemePreference` (lines 21–25)
  turned `light`/`dark` into `zai-light`/`zai-dark`, and `applyTheme("system")` (lines 60–80) set
  the `theme-zai-*` classes. Migrating to `neutral` would change the appearance and break
  acceptance criterion 1.
- New key `zcode-theme-palette` for the palette. Missing or unknown value → palette `zai`.
- Migration runs on every read and never writes back to `zcode-theme`.

## 5. Terminal

- Terminal colors come only from the `--color-terminal-*` tokens
  (`packages/ui/src/terminal/terminalTheme.ts`, `TERMINAL_THEME_TOKENS`). Palettes do not set these
  tokens, so **switching the palette does not recolor the terminal**. This is an accepted decision;
  it differs from the original plan and needs confirmation.
- Switching the mode (`light` / `dark` / `system`) recolors xterm: `TerminalSession.tsx` watches the
  `class` attribute on `<html>` with a MutationObserver (lines ~356–364, ~489–498, ~859–865).
  Palette classes also trigger the observer, but the resulting colors are the same. Verified by
  reading the code, not by running it.
- WebGL: `@xterm/addon-webgl@^0.18.0` (peer `@xterm/xterm ^5.0.0`). `@xterm/xterm` stays on
  `^5.5.0`; moving to 6 is out of scope. Wiring in `terminalWebglRenderer.ts`: an activation
  exception (for example, no WebGL2) → the addon is released and the terminal stays on DOM; WebGL
  context loss → fallback to DOM. `TerminalSession` calls `setTerminalWebglRenderer` in three
  places: when creating the sidebar terminal (`TerminalSession.tsx` ~426), the bottom-panel terminal
  (~794), and in the flag-toggle effect (~1102–1103), which turns the renderer on or off on an
  already open terminal without a reload.

## 6. CLI

- New key `ui.palette` (`apps/zcode-cli/packages/contracts/src/config/index.ts:79–80,260,300`, type
  `UiThemePalette`): `neutral | zai | ocean | forest | ember | violet | slate | rose | sand | mint`,
  default `neutral`. Persisted in `~/.zcode/config.json`: `adapters/src/config/schema.ts` must
  declare the key or zod drops it. An invalid value is coerced to `undefined`. `config-factory.ts`
  has no source tracker for `palette`; not fixed.
- D7 (surfaces) does not apply in the TUI: only accents are overridden.
- TUI: all consumers read the theme through `activeTuiTheme()`
  (`apps/zcode-cli/packages/tui/src/theme/state.ts`). `resolveTuiThemeTokens(mode, palette)`
  (`tui/src/theme/palettes.ts`) overrides only `primary`, `accent` and `borderActive` for accent
  palettes in `light` or `dark` mode. `neutral` and `zai` override nothing.
- The TUI cannot import `@zcode/ui`, so the accent table is duplicated (`ACCENT_OVERRIDES`). It must
  be kept in sync with `themePalettes.ts` manually. There are no tests in `packages/tui`; verified
  by typecheck and lint.

## 7. Not done in this iteration

- A "Recent" palette list: a Select is enough.
- Accent palettes build on `neutral`, not `zai`. The combination "zai background + accent" is not
  supported.
- The `--color-ring` token is used at `styles.css:1602` and in about 46 places (`ring-ring`,
  `border-ring`, `outline-ring`) but is not defined in the base themes. Pre-existing problem: the
  focus ring has no color in any theme, including zai. Palettes set it only in their light blocks
  (D6). A global definition is a separate task. Also, the global focus suppression
  (`styles.css:121–127`) hides even the palette color rings (§9).
- Selections (`--color-selected`, `--color-hover`), borders and text are not recolored (D7).
- Server-side palette storage (see D2/D3).
- User-defined custom palettes.

## 8. Acceptance criteria

1. Old `zcode-theme` values produce the same appearance as before the change
   (`light`/`dark`/`zai-*`). _Migration is covered by a test; appearance was not checked._
2. Switching the palette in settings changes primary controls, focus rings and surfaces (background,
   sidebar, cards) without a reload. _Web: verified in the browser (`<html>` classes, CSS variables,
   `localStorage`, restore after reload) in light and dark. Desktop (Electron) and visual review
   were not. Caveat: focus rings change as a variable but are visually invisible due to the global
   focus suppression (`styles.css:121–127`, §9)._
3. Switching the mode (`light` / `dark` / `system`) recolors an open terminal. Switching the palette
   does not recolor the terminal (see §5). _Verified by reading the code; not run manually._
4. The WebGL toggle turns the renderer on and off without a reload; on WebGL failure the terminal
   works on DOM. _Not run: WebGL in Electron was not verified._
5. In the CLI, `ui.palette` changes TUI accents; without the key the behavior is unchanged.
   _Verified by typecheck and lint; the TUI was not run._
6. All three languages (`en-US`, `zh-CN`, `uk-UA`) contain the new keys. _Verified by
   `i18nCatalogParity.test.ts`._
7. Migration, contrast and validation tests pass. _`themeMigration.test.ts` (10) and
   `themeContrast.test.ts` (6): 16 of 16 pass. Contrast is computed against approximate backgrounds
   (§2)._

## 9. Open questions

- D2: confirm the independent CLI `ui.palette` key without a desktop bridge.
- §5: should the palette recolor the terminal? Currently it does not.
- WebGL is off by default and not synced between windows. Confirm.
- Palette names and accent hex were chosen unilaterally.
- D6: confirm that palettes override `--color-primary` and `--color-ring`. This changes buttons,
  switches and checkboxes.
- D7: confirm the surface tint intensity after visual review in the browser and Electron.
- Define `--color-ring` globally in the base themes, or keep the decision local to palettes.
- Programmatic and keyboard focus produces no `box-shadow`. Cause found during review 2026-10-10:
  the global rule at `styles.css:121–127`
  (`*:focus, *:focus-visible { outline: none !important; box-shadow: none !important; }`,
  pre-existing) suppresses focus styles on the focused element itself. So the palettes'
  `--color-ring` changes as a variable but is visually present only in wf-\* components (there the
  outline is drawn on the container via `:has()`); buttons, inputs and switches have no ring. This
  is unrelated to `:focus-visible`. Showing focus and a global ring is a separate task, out of this
  feature.
- Manual review: palette visuals in Electron, WebGL, `index.html` bootstrap, CLI config, TUI.
