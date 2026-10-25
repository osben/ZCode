# Session context menu structure

Status: draft 2026-10-25 (user request: regroup the flat session menu logically, like Codex / Linear / Finder-style menus with sections and submenus). Owners: `packages/ui/src/TaskActionMenuContent.tsx` (shared flat/header/sidebar menu), `packages/ui/src/project-sidebar/grouped/task-context-menu-content.tsx` (grouped sidebar menu).

## Problem

The menu is one flat list of 12–15 entries. Rarely used diagnostics (Copy log path, Copy session ID, Go to config, two trajectory entries) sit next to everyday actions, and "Archive" is mixed into the same block as "Rename".

## Product rules

Sections are separated by a divider, in this order (an empty section and its divider are omitted):

1. **Organize** — Move to group ▸ (grouped sidebar only, with Move to top), Pin / Unpin.
2. **Edit** — Rename, Mark as unread.
3. **Open ▸** — file manager (Finder / Explorer / File Manager), Go to config. Hidden when `canOpenInFileManager` is false (web) or on narrow remote; pull-request Open items stay in the pull request section below.
4. **Copy ▸** — Copy path, Copy task path (only when the snapshot file exists), Copy log path, Copy session ID.
5. **Inspect ▸** — View model trajectory, View model trajectory v2 (each only when its handler is provided).
6. **Pull request section** — unchanged (`specs/sidebar-pr-status.md`), rendered by `TaskPullRequestMenuItems`.
7. **Report issue** — own section.
8. **Danger** — Archive / Unarchive, then Delete (destructive, last, own divider).

Rules:

- Submenu labels: `taskList.menu.open`, `taskList.menu.copy`, `taskList.menu.inspect`. Item labels and test ids are unchanged, but items inside a submenu are not mounted until its trigger is opened: E2E tests must click the trigger first (`TID_TASK_INSPECT_MENU` for the trajectory items).
- A submenu with no visible items is not rendered. A submenu with exactly one item is rendered flat (no pointless nesting).
- Disabled/read-only semantics are unchanged: every item keeps its current `disabled` and `title` rules; submenu triggers are disabled only when every child would be disabled.
- Menu primitives are injected: `TaskActionMenuContent` takes optional `Sub`, `SubTrigger`, `SubContent`. Without them (legacy callers, tests) it renders the same items flat in the new order. The header More dropdown and the sidebar context menu both pass them; the header menu omits them on a narrow remote (`simplifyForNarrowRemote`) so mobile keeps the flat list.

## Session manager row menu

`packages/ui/src/session-manager/SessionManagerRowView.tsx` keeps its own icon-style menu (it has no unread/trajectory/feedback handlers and its rows are table rows). It follows the same grouping: Open session, Rename, Pin | file manager, Copy ▸ (Copy path, Copy log path, Copy session ID) | Archive/Restore, Delete. Copy log path and Copy session ID are new there; path probing is already gated on the menu being open.

## Not in scope

Child session rows (two items), the Agent row menu, the full-view conversation menu and side pane tab menus stay flat. Fork, Share, Open in new window and Export do not exist in ZCode; they would be separate features.

## Acceptance

1. Right-click a session in the sidebar → top level shows Pin, Rename, Mark as unread, Open ▸, Copy ▸, Inspect ▸, Report issue, Archive (≈8 rows instead of 14).
2. Copy ▸ contains Copy path, Copy log path, Copy session ID (Copy task path when the file exists).
3. Web build: no Open ▸ submenu; Copy ▸ still present.
4. Delete (when provided) is last and destructive-styled; Archive precedes it.
5. Grouped sidebar menu keeps Move to group ▸ and Move to top first; system group titles stay localized.
6. Unit tests assert section order, submenu content, and the flat fallback.
