# Settings MCP list

MCP server rows present ownership scope as compact metadata beside the server name.

- User and Workspace scope use the shared `Badge` treatment from Skill rows.
- The badge uses `rounded-full`, `border-border`, `bg-surface`, and `text-ui-sm`.
- A 14px leading icon identifies the scope: `UserRound` for User and `Folder` for Workspace.
- Scope labels remain the localized `User` / `Workspace` values.
- Configured MCP rows do not display their backing configuration directory path; location data remains available to configuration and editing logic.
- Runtime status dots and server names share a layout wrapper, but the name-only element owns `text-foreground`; status colors do not inherit from the server-name text style.
- Disconnected or unknown status dots use the tertiary foreground token `text-foreground-subtlest`; connected, connecting, and error retain their semantic colors.
- Hovering a status dot shows the reason. Configured servers use localized runtime explanations and prefer the actual server error when available; plugin servers reuse their resolved status description, including disabled and authorization-required explanations.
- Status-reason tooltips use `max-w-64` so longer explanations wrap within a compact 256px width.
- Item descriptions use `text-ui-sm text-foreground-subtle` as secondary copy.
- Tool-count metadata uses `text-ui-sm` in both configured and plugin-provided MCP rows.

Plugin-provided MCP rows show plugin ownership beside the MCP server name.

- Plugin ownership is expressed by the group title; rows do not repeat a Plugin badge or marketplace.
- Plugin names use the canonical display-name formatter, including converting slug-like names into title-cased words.
- Plugin MCP is grouped by stable `pluginId`; same-name different-id entries are not merged. Plugin groups sort by normalized display name; pending items come first within a group, the rest keep declaration order.
- Runtime status is represented only by the status dot and its hover explanation; plugin MCP rows do not repeat status as a text badge. Tool count remains separate metadata.
- Plugin MCP names reuse the configured-server status dot: connected is green, connecting is a yellow spinner, errors are red, disconnected or unknown is tertiary foreground, and authorization-required is a static yellow dot. Plugin-disabled is part of this status resolution, takes precedence over stale runtime state, and always renders a static tertiary-foreground dot.

Configured and plugin MCP share one failure display: a `failureKind`-localized summary uses normal secondary text color, and the error state colors only the status dot red. The raw `error` is shown on demand in a Popover via a small info button after the summary; the server request id is appended to that selectable detail text as ` - <requestId>` instead of being shown separately or getting a second copy button. Never reverse-derive business classification from the error text.
A successful connection, reconnection, or workspace switch must clear old diagnostics.

Official Server MCP JSON-RPC error codes are first mapped to stable settings-page categories: `1006` shows "未登录，请先登录 ZCode" (not logged in, log in to ZCode first) and `3101` shows "当前账号没有 Coding Plan，请先购买或配置 Coding Plan" (this account has no Coding Plan; purchase or configure one first); neither is shown as a generic "protocol request failed".

MCP, Skills, and Commands share `SettingsResourceGroupHeader` and `SettingsResourceList`: `space-y-6` between groups, `space-y-4` inside a group, `h-7 text-ui-base` titles, `text-ui-sm` counts, `rounded-xl bg-surface` lists, and standalone `h-px bg-border/50` row separators.
