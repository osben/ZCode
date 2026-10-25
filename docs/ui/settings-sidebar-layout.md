# Settings Sidebar Layout

Settings uses a desktop-style two-column layout, consistently using the semantic tokens in [DESIGN.md](../../DESIGN.md#color-palette):

- The outer container uses `bg-background + border-border` to form a distinct Settings workspace.
- The left navigation uses `bg-sidebar` and contains the back button, section navigation, and current-section description.
- Make the left navigation responsive to window width: at `lg` and above, keep a 264px text sidebar (256px content width plus 8px safety margin); below `lg`, collapse it to a 64px icon sidebar, hide visible text, and expose the titles of the back, section, and onboarding entries through tooltips. This prevents a narrow window from squeezing the Settings content on the right.
- Keep the right content area on `bg-background`, separate the title from Settings content, and constrain body text to a medium reading width.
- Use `bg-card + border-border` consistently for Settings item cards and `border-border` for dividers between rows.
- Prefer `bg-input / border-input-border / bg-hover / bg-selected` for interactive controls instead of assembling new neutral colors locally.
- Align the shared `Card` base style with `bg-card + border-card-border + text-foreground` to keep page components from restating card-outline semantics.

## Navigation Groups

Keep the existing route semantics for Settings entries, but organize them into three visible groups based on user tasks. `packages/ui/src/settings/settingsPageConfig.ts` is the single owner of group membership and order:

- **Basics** (app-level preferences): General, Appearance, Model Settings, Keyboard Shortcuts, Voice Input, Worktrees (Desktop only).
- **Agent capabilities** (what the Agent knows and can use or control): Instructions, Output Styles, Memory, Subagents, Plugins, MCP servers, Skills, Commands, Hooks, Browser, Computer Use (Desktop only). Browser and Computer Use are Agent control surfaces ("control the browser / control the whole computer"), so they sit after Hooks, adjacent to each other.
- **Data and statistics:** Usage Stats, Sessions.

Group titles are navigation structure, not clickable entries. Show localized titles in the wide sidebar. When collapsed to a 64px icon rail below `lg`, hide visible titles and preserve group boundaries with subtle dividers. Give each group its own accessible group name; retain tooltips, `aria-current`, and existing test IDs for entries. Keep the onboarding entry after the grouped list, outside the Settings groups.

Grouping affects only the navigation visuals and semantic structure of the Settings page shared by desktop/Web. Do not change Settings section IDs, recently visited sections, explicit navigation intent, content routes, or persistence. Mobile `/remote` currently has no Settings entry point, so do not add mobile-specific interaction; verify only the responsive icon rail at narrow window widths.

### Hidden and legacy section IDs

These IDs stay valid in `SettingsSectionId` so stored preferences and older callers resolve, but they never appear in navigation and `resolveSettingsSection` falls back to the default section (via `HIDDEN_SETTINGS_SECTIONS` in `lib/settingsNavigation.ts`):

- `automations`: a workspace main view, not a Settings section.
- `plugins`: the old marketplace; resolves to `plugin`.
- `workspaceFileSearch`: temporarily hidden; the `.zcodeignore` rules file still applies.
- `migration`: the section has no navigation entry and no caller; the onboarding dialog owns the migration flow. Hiding it prevents a stale intent from landing on an unreachable page.

Current entry responsibilities:

- **General:** language, interface mode, terminal, proxy, notifications, message-stream display, task auto-archive, data directory.
- **Appearance:** theme, code-block preview (themes, line numbers, wrapping, font size).
- **Model Settings:** model providers, credentials, and available models (Lucide `Package`).
- **Keyboard Shortcuts / Voice Input:** shortcut bindings; dictation models, microphone, recording mode.
- **Worktrees:** defaults for the "New task in worktree" flow; Desktop only.
- **Instructions / Output Styles / Memory:** user-scoped prompt material, response style, and project memory.
- **Subagents / Skills / Commands / Hooks:** Agent extension resources; **Plugins** (Lucide `Blocks`) and **MCP servers** (Lucide `Cable`) are the unified extension entries.
- **Browser:** Browser Use plugin toggle, one-time Chrome data import, built-in browser data cleanup.
- **Computer Use:** whole-computer control permissions; Desktop only.
- **Usage Stats / Sessions:** app and coding-plan usage; cross-workspace session management.

Navigation intent to a section that was later hidden from an older window falls back to the visible default section, preventing a blank Settings page.

## Isolation for Blocking Interactions

After Settings opens, it is the only interactive primary surface in the current window. The underlying workspace stays mounted to preserve session subscriptions, drafts, terminals, and layout state, but must be marked with both `aria-hidden` and `inert`. Opacity and `pointer-events` alone are insufficient because a permission card's autofocus could still steal focus from the Settings form.

```text
CLI pending interaction
  -> conversation snapshot continues updating
  -> workspace covered by Settings (mounted + aria-hidden + inert)
       |-> does not focus Permission / AskUserQuestion
       |-> does not accept keyboard or pointer input
       `-> task badge / system notification may still provide a cue

User explicitly returns to workspace or clicks a task notification
  -> settings layer closes
  -> workspace removes inert
  -> pending interaction appears in the original task's bottom dock
```

| Current surface | Background event                                | Expected result                                                                                            |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Settings        | Regular permission request                      | Settings, form values, and current focus remain unchanged; request stays on the original task              |
| Settings        | `AskUserQuestion`                               | Use the same surface-isolation rule as regular permissions; do not force a switch back to the conversation |
| Settings        | Request completes or is dismissed automatically | Update only the background task projection; do not switch away from Settings                               |
| Workspace       | Permission or question remains pending          | Show and allow response using the existing bottom-dock interaction                                         |

This boundary governs Renderer surfaces and focus ownership only. Do not change `pendingInteractions`, request countdowns, permission responses, task notifications, desktop `desktop-continuous`, or mobile `web-remote-replayable` protocol/recovery semantics. When the mobile `/remote` view has no desktop Settings overlay, continue using existing mobile interactions; do not infer new remote-control behavior from this case.

This change affects only UI structure and visual hierarchy; it does not change underlying Settings state, persistence, or logic shared between desktop and Web.
