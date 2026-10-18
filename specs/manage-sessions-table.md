# Manage sessions: full-screen sessions table (ZCO-34, Copilot /recent analog)

Status: implemented on feat/zco34-manage-sessions (2026-10-16). Revised after design review: workspace universe for the unscoped view fixed (§2), delete semantics corrected (§7–8), mutation lane corrected to per-workspace `zcodeTaskService` (§2), search wording corrected to LIKE (§2).

## Problem

Session management today is scattered across per-workspace sidebar sections (pinned, active, archived flat lists) and `TaskSearchDialog`. There is no single surface to scan, filter, and bulk-manage the sessions of a project: no columns (status, changes, branch, environment, model), no bulk archive/delete, no cross-workspace grouping. Copilot solves this with a full-screen `/recent` sessions table (filters persisted in localStorage, grouped rows, row menu, bulk delete with pinned-session exclusion). Our data layer is already sufficient (all verified against source):

- `listTaskList(ZCodeTaskListQuery)` — `packages/services/src/session/zcodeTaskListTypes.ts:5-25`: kinds `pinned | archived | timeline | active`, multi-workspace `workspaceScopes`, `search`, `sortBy: created | updated`, `limit`/`hasMore`. UI hook: `packages/ui/src/hooks/useGlobalTaskList.ts`; shared cache/delta invalidation: `packages/ui/src/v4/windowControllerTaskListRegistry.ts` (subscribes `CONTROLLER_TASKS_INDEX_TOPIC`; invalidates cached queries per membership kind — `registry.ts:168-181`). `queryTaskList` (`packages/services/src/session/taskIndexRepo.ts:2153`) matches `LOWER(title) LIKE ? OR LOWER(searchable_text) LIKE ?` — a case-insensitive substring scan, not FTS5 (keep this in mind for cost expectations).
- Row shape `WindowHostControllerTaskRow` — `packages/shared/src/zcode-protocol-v4/controller.ts:90-120`: `meta` (title, createdAt/updatedAt, model, provider, changeSummary `{fileCount, added, removed}` per `zcode-task-types-core.ts:396`, executionWorktree `{path, branchName?}` + top-level `executionWorktreeMissing`, cronAutomationId, offPeakTaskId), `membership {pinned, archived, active}`, `sourceAvailability online|offline`, `liveStatus idle|running|waiting|completed|error`, `activity`.
- Membership semantics — `matchesTaskListMembershipKind`, `controller.ts:126-144`: `active = !archived` (includes pinned), `pinned = pinned && !archived`, `archived = archived`.
- Controller mutations — `WindowHostControllerMutation`, `packages/services/src/window-controller/windowController.ts:23-31`: `pin | archive | delete | delete-archived | mark-read | mark-unread | open | resume`. `open`/`resume` are source-validation no-ops Host-side (`packages/desktop/src/host/windowHostControllerService.ts:281-284`); the UI never calls `mutateTask` directly — sidebar sections mutate through per-workspace `zcodeTaskService` (`setTaskPinned`, `archiveTask`, `unarchiveTask`, `deleteTask`, `deleteArchivedTask(s)`, `renameTask` — `packages/services/src/session/zcodeTaskService.ts:527,745,752,764`), resolved via `buildWorkspaceServiceLookup` (`packages/ui/src/lib/workspaceServiceResolver.ts`); local workspaces always resolve through base services, remote ones require a live remote session.
- Known gaps (drive the non-goals): no PR data anywhere, no `archived_at` timestamp (boolean only), no per-task disk size, token usage is per-session RPC only, no table primitive in `components/ui` (heavy lists use `@tanstack/react-virtual`; the closest table precedent is the ArtifactTable plain `<table>` with sticky thead).

## Goals

- One full-screen surface in the main window to browse, filter, and manage sessions across workspaces, scoped to one workspace when entered from its project menu.
- v1 column set, filters, grouping, row actions, and bulk archive/delete with Copilot-parity pinned-exclusion, read-only over existing RPC (mutations only through existing task-service ops).
- Per-device view-state persistence (localStorage), zero new stores, zero DB/protocol changes.

## Non-goals (v1)

- PR columns (Branch-or-PR, Checks, Approval) — no GitHub data layer exists.
- Disk usage column — follow-up slice of this same issue (§12).
- Automatic-cleanup settings entry — separate cleanup issue (blocked on `archived_at`).
- Token usage column (per-session RPC only; would be N calls).
- Search-snippet rendering in rows (search filters rows; snippets stay unrendered while rows are single-line).
- Any change to sidebar behavior, task-list wire schema, or database.

## Contract

### 1. Hosting and entry points

- **The manager is a Settings section** (2026-10-17 redesign, replaces the store-level `__sessions__` tab): `sessions` in the `dataAndStats` group of the settings page. The settings shell owns the sidebar, back-to-workspace, breadcrumb, title, and window-chrome handling; the section renders scope chip, search, columns menu, filter bar, table, bulk bar, and delete dialog. The former standalone tab/layer machinery (singleton tab in `tabStore`, shell content-column mounting, its own back control and title-bar drag row) was removed because it kept producing placement/back-contract bugs.
- Persistence: workspace-tab persistence is untouched (the manager is no longer a tab at all); the table view state keeps `zcode.sessionManager.view.v1` in localStorage (§5).
- Navigation uses the settings intent mechanism (`packages/ui/src/lib/settingsNavigation.ts`): `setPendingSettingsSectionIntent("sessions", { sessionsScope })` + the same-window intent event, mirroring the plugin/usage intents.
- Entries:
  1. Project action menu (workspace `⋯` menu in the sidebar, `WorkspaceSidebarItem.tsx`) → **"Manage sessions"**: sets the intent with a **workspace scope** `{workspacePath, workspaceIdentity}` and opens Settings on the sessions section (Copilot parity: its project menu navigates to `/recent` with `state: { repoFilter }`).
  2. **Command Center / quick pick**: a `manage-sessions` command opens the section **unscoped**.
- Opening the section again re-uses the live Settings page through the intent event and replaces the scope. Scope is ephemeral navigation state (sessionStorage intent consumed once, then section-local until cleared with the chip ✕) — it does not survive leaving Settings, matching the old tab-scope semantics.
- **Back** to the workspace is the Settings sidebar's existing "Back to workspace" control — no dedicated back contract for the manager anymore.

### 2. Data flow (read-only, single owner)

- Rows come from the existing sessions-index projection through **`useGlobalTaskList` reused as-is**: it already runs one multi-scope `listTaskList` query per membership kind through the shared registry (`useGlobalTaskList.ts:25-40` builds deduped scopes; the registry caches per query key and invalidates precisely by membership — `windowControllerTaskListRegistry.ts:168-181`). The manager does not create a second store.
- **Workspace universe (review decision)**:
  - _Scoped mode_ (project-menu entry): exactly one scope — the entry workspace `{workspacePath, workspaceIdentity}`.
  - _Unscoped mode_ (Command Center entry): open workspace tabs ∪ the entry workspace (if any) ∪ `recentProjects` from app settings (local paths, capped at 10 by persistence). This is a deliberate v1 bound: there is no UI-side enumeration of "all workspaces with sessions" today (`queryTaskList` returns an empty result for empty scopes — `taskIndexRepo.ts:2157-2160`; the registry discards `CONTROLLER_WORKSPACES_TOPIC` payloads — `registry.ts:148-151`), and this union needs zero new state and zero protocol change. Consequence: a workspace whose sessions exist but that was never opened or recent is not listed until opened. A true "all workspaces" enumeration is a follow-up (consume workspace-fact frames or a `listTaskList` wildcard) and is NOT part of v1.
  - Pseudo-tab shapes feed `useGlobalTaskList.workspaceTabs` (it needs only `{workspacePath, workspaceIdentity?, remoteSessionId?}`).
- Status filter maps to list kinds: `Active` (default) → `kind: "active"` (pinned included); `Archived` → `kind: "archived"`; `All` → both hooks active + archived, merged and tagged by row `membership.archived`.
- Search forwards to the query's `search` param (debounced 250 ms). Remember it is a LIKE scan over `title`/`searchable_text`, not an FTS index.
- Load strategy: **unbounded within the universe** (`expanded: true`) — the universe is small (open tabs + ≤10 recent projects), and `sortBy` orders server-side. No load-more UI in v1; revisit with the "all workspaces" follow-up.
- Live updates: no polling — registry revision bumps on controller frames re-run the hooks; externally deleted rows disappear from the table and from the selection set.
- Mutations go through per-workspace `zcodeTaskService` resolved by `buildWorkspaceServiceLookup(scopes, baseServices, remoteSessionSessionStoreState)` — the `WorkspaceArchivedTasksFlatSection.tsx:82-131` pattern — followed by `applyTaskQueryCacheMutation` / `removeTaskFromTaskCaches` so sidebar caches stay coherent (`WorkspaceArchivedTasksFlatSection.tsx:242-254,309-313`). `sourceAvailability: "offline"` rows render dimmed with mutations disabled (read-only reason pattern `isWorkspaceReadOnly`, `tabStore.ts:73-85`). Rows whose workspace resolves to no services (remote workspace whose session is gone) are rendered but action-disabled for the same reason.
- Sorting: `sortBy` supports `created | updated` end-to-end; **Name** sort is client-side within groups. Default: Updated desc.

### 3. Layout

Hosting frame (2026-10-17 redesign): the section renders inside the Settings content frame like every other section — the Settings shell provides the panel, title row, and window-chrome handling. The section-local header keeps the scope chip, search, and Columns menu; no title-bar drag row of its own.

Three stacked regions inside the section (toolbar row, filter bar ~44px, table flex-1):

1. **Toolbar row** (`bg-header`, `border-b border-border`): removable **scope chip** when workspace-scoped (folder icon + workspace name; ✕ clears the scope → unscoped view; not persisted), spacer, search input (~230px, `/` shortcut focus), Columns button (popover with per-column checkboxes, persisted). The "Manage sessions" title and Back control belong to the Settings shell, not this row.
2. **Filter bar**: segmented dropdowns **Status** (Active/Archived/All; default Active), **Environment** (All/Local/Worktree; client-side on `executionWorktree` presence), **Type** (All/Session/Cron/Off-peak; client-side on `cronAutomationId`/`offPeakTaskId`), **Pinned** toggle chip (client-side `membership.pinned`; no-op under Status=Archived), **Reset filters** (appears when any filter deviates from default), right-aligned count "N sessions · X running" (running = liveStatus `running|waiting`).
3. **Table**: grouped rows (§6), virtualized with `@tanstack/react-virtual` over the flattened group-header+row model; sticky thead (`bg-header`, 32px, `text-ui-xs text-foreground-subtle`); dense single-line rows (34px, `border-b border-border`), hover `bg-surface-hover`, selected `bg-selected`. Minimum table width ~1060px with horizontal scroll inside the content area below that.

Empty states (review addition): zero workspaces in scope → centered hint with the unscoped explanation; no sessions after filters → "No sessions match these filters"; no sessions at all → "No sessions yet"; while loading → the existing `TaskListLoadingHint` idiom.

Accessibility: the table is a real `<table>`-shaped grid with `role="row"` on virtualized rows; every row is focusable (`tabIndex={0}` in DOM order — no roving-tabindex machinery in v1) and activates on Enter/Space; checkboxes, menu buttons, and the star toggle are standard controls with `aria-label`s; the selection count bar is `aria-live="polite"`.

### 4. Columns (v1)

| #   | Column      | Source                                      | Rendering                                                                                                                              | Default                                     | Sort   |
| --- | ----------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------ |
| 1   | Selection   | —                                           | Checkbox; header = select-all-in-view (indeterminate on partial)                                                                       | always                                      | —      |
| 2   | Pinned      | `membership.pinned`                         | Star icon button; filled amber when pinned; click = `setTaskPinned` toggle                                                             | on                                          | —      |
| 3   | Name        | `meta.title` (fallback `taskList.untitled`) | `text-ui-base`; inline rename (§7)                                                                                                     | on                                          | client |
| 4   | Status      | `liveStatus`                                | Pill 20px: Running (success, pulsing dot) / Waiting (warning) / Idle (neutral) / Done (subtle) / Error (destructive)                   | on                                          | —      |
| 5   | Type        | `cronAutomationId` / `offPeakTaskId`        | Icon+label, sidebar vocabulary: message-square Session / clock Cron / moon Off-peak                                                    | on                                          | —      |
| 6   | Changes     | `meta.changeSummary`                        | Mono tabular `+added −removed` in success/destructive; `—` when both zero or summary absent                                            | on                                          | —      |
| 7   | Branch      | `executionWorktree.branchName`              | Mono `text-ui-xs` + git-branch glyph; `—` when absent; `executionWorktreeMissing` → destructive "missing" text with tooltip            | on                                          | —      |
| 8   | Environment | `executionWorktree` presence                | `Worktree` bordered chip / `Local` plain text — deliberately **neutral colors** (violet stays reserved per the worktree-icon decision) | on                                          | —      |
| 9   | Model       | `meta.model` display name                   | `text-ui-sm text-foreground-subtle`                                                                                                    | on                                          | —      |
| 10  | Updated     | `meta.updatedAt`                            | Relative time (`formatTaskRelativeTime`)                                                                                               | on                                          | server |
| 11  | Created     | `meta.createdAt`                            | Short date                                                                                                                             | on                                          | server |
| 12  | Path        | `meta.workspacePath`                        | Mono `text-ui-xs` truncated, full path in tooltip                                                                                      | **off when workspace-scoped**, on otherwise | —      |
| 13  | Row menu    | —                                           | `⋯` ghost button → context menu (§7)                                                                                                   | always                                      | —      |

Column visibility persists per device (§5). Child-session counts and workflow-run lines are **not** columns in v1.

### 5. View state ownership

One namespaced localStorage JSON key `zcode.sessionManager.view.v1` (per device, never broadcast, never `setting.json` — fork-unsafe storage rule): `{ status, environment, type, pinnedOnly, sort: {column, direction}, columns: string[], collapsedGroups: string[] }` (search deliberately NOT persisted — ephemeral like Copilot's session filter typing). Parse is defensive (unknown fields dropped, defaults per §3/§4); malformed JSON falls back to defaults silently on read.

### 6. Grouping

- Rows group by workspace key `buildTaskWorkspaceKey(workspacePath, workspaceIdentity)` (`packages/ui/src/lib/taskQueryCache.ts:40`) — identity-first with path fallback, the uniform repo rule.
- Group header row (34px, `bg-background`): chevron, folder glyph, workspace name (medium), path (mono, subtlest), count "N sessions · X active". Click toggles collapse.
- Groups sort by most recent row `updatedAt` desc; rows inside a group follow the active sort. Collapsed state persists in the view key.
- Workspace-scoped view: exactly one group, header still rendered (counts stay truthful), not collapsible.
- Pinned sessions are **not** a separate section — rows with a filled star; the Pinned filter isolates them.

### 7. Row actions

Context menu on the row / `⋯` button:

- **Open** — activates the session through the standard select path (`activateTabByPath(path, {workspaceIdentity})` + task selection, the `useWorkspaceTaskNavigation` composition — `App.tsx:962-973`); Open navigates to the session's workspace — Settings stays open, and the user returns to it via the Settings shell's back control. Disabled for offline rows. Offered for archived rows too (opening history is read-only).
- **Rename** — inline input replacing the Name cell; Enter/blur commits via `zcodeTaskService.renameTask`, Esc cancels; empty commits fall back to the untitled label. Allowed for running sessions (decision): rename rewrites the indexed title (`title_overridden`); a running session's auto-titling may overwrite a manual name on its next turn — accepted caveat, not worked around.
- **Pin / Unpin** — `setTaskPinned` toggle.
- _separator_
- **Show in Finder / File Manager** (platform label) — `useTaskListItemContextActions` path.
- **Copy path** — workspace path copy idiom.
- _separator_
- **Archive** / **Restore** (archived rows) — `archiveTask` / `unarchiveTask`; reversible, no confirmation.
- **Delete** — destructive, always confirmed via the §8 dialog (single-row preselection). Semantics (review-corrected): non-archived row → `deleteTask` = **index tombstone** (row hidden; CLI session content retained on disk); archived row → `deleteArchivedTask` = **permanent index removal** (row gone from every list; CLI session content still retained — `zcodeTaskService.ts:748-757`). Neither path deletes files in v1.

### 8. Bulk selection

- Checkbox selection is ephemeral; deleting/archiving a selected row removes it from selection; externally removed rows drop out of the selection via projection deltas.
- With ≥1 selected, a floating bulk bar (`bg-card border border-border rounded-lg shadow-lg`, bottom-center) shows: "N selected" · **Archive** · **Delete** · clear (✕).
- **Bulk Archive**: no confirmation (reversible). Loops `archiveTask`; partial failures surface one error toast and keep the bar.
- **Bulk Delete**: always opens the confirm dialog (Copilot `BulkDeleteSessionsDialog` parity — verified in its bundle: `bulk-delete.includePinned` flag, "Include N pinned session(s)" checkbox, pinned excluded by default):
  - Title "Delete N sessions?"; body states the corrected rule: "Sessions are removed from this list. Session files stay on disk."
  - Compact list of up to 5 selected rows (icon: star when pinned / git-branch when worktree / message-square otherwise) + "+N more".
  - Pinned rows in the selection: checkbox "Include N pinned session(s)", **unchecked by default**; confirming with it unchecked deletes only the non-pinned subset (counts update). Pinned rows cannot be deleted without the explicit opt-in.
  - Execution (review-corrected): non-archived rows → loop `deleteTask` (no plural tombstone op exists; per-task failures are collected); archived rows → `deleteArchivedTasks` batch per workspace (its still-archived guard makes it race-safe: rows restored elsewhere are skipped and reported, `zcodeTaskService.ts:752-757`). Partial failures surface one error toast naming the count; the dialog closes and the table reflects whatever succeeded.
  - Confirm button label "Delete K" (K = rows actually deleted), destructive styling.

### 9. i18n

All user-facing strings under the `sessionManager.*` namespace in `en-US`, `zh-CN`, `uk-UA`: title, filter labels and values, column headers, count sentences (correct plurals — uk-UA three-form Slavic), row-menu items, bulk bar, delete dialog (title, body, pinned-inclusion with plural categories, confirm/cancel), empty states, offline reason (reuses existing `workspaceSidebar.unavailableLocalDirectory`). The `i18nCatalogParity` test enforces key parity across locales. No hardcoded strings in components.

### 10. Performance

- Virtualization over the flattened row model (`@tanstack/react-virtual`) — row components memoized on stable row identity (`workspaceKey::taskId` — `taskQueryCache.ts:47` idiom) + the fields each cell renders.
- Search debounce 250 ms; LIKE scans are the Host's cost, one per debounce tick per kind.
- No polling, no timers; all updates ride registry revisions.

### 11. Tests

- **Unit** (colocated vitest, `*.test.ts`): view-state parse/defaults/unknown-field dropping (malformed JSON); model reductions — status-kind mapping, client filters (environment/type/pinned), sorts, identity-key grouping incl. remote identity fallback, select-all keys; delete-candidate arithmetic (mixed pinned selection, pinned-only selection → confirm disabled until opt-in, archived/non-archived split).
- **Contract**: `zcode.sessionManager.view.v1` shape snapshot (guards accidental key renames).
- **E2E**: bulk flows — deferred to the CI e2e lane (local mac e2e is blocked by onboarding harness constraints); tracked in the issue, not in this slice's PR.

### 12. Follow-up slices (same issue, after v1)

- **Disk column**: per-task disk size (Host-side async stat of `v2/sessions/<hash>/<taskId>.json` + worktree dir for visible rows only; Copilot-style relative bars; tooltip "Files: x · Conversation: y"). Needs its own spec addendum.
- **True all-workspaces enumeration**: consume workspace-fact frames or add a `listTaskList` wildcard (protocol change) — replaces the §2 universe bound.

### 13. Compatibility

- Read-only over existing RPC; all mutations are existing task-service ops — additive UI only, no wire/DB changes, no migrations.
- Old CLI + new UI: all consumed fields already exist; remote/offline workspaces render action-disabled, not hidden.
- Fork safety: single namespaced localStorage key; no `setting.json` keys; no fork\_/upstream DB surface.

## Acceptance scenarios

1. Project menu "Manage sessions" on workspace W opens Settings on the sessions section scoped to W (chip visible, Path column hidden); clearing the chip shows the universe grouped by workspace key; nothing view-related persists across app restart except §5 preferences.
2. Status=Archived shows only archived rows with Restore in the menu; Restore returns the row to the Active view without reload.
3. Deleting a running session (tombstone) removes the row immediately and it does not resurrect after restart; the CLI session directory still exists on disk.
4. Bulk-selecting 3 rows of which 1 is pinned: dialog shows "Include 1 pinned session" unchecked; confirming deletes 2 rows and keeps the pinned row.
5. Filter/sort/columns/collapse state survives an app restart on the same device and does **not** appear on another device (no broadcast).
6. Offline remote workspace: rows render dimmed with disabled mutations and a read-only reason; nothing throws.
7. A workspace in `recentProjects` that has no open tab appears in the unscoped view (read + local mutations); a remote workspace without a live session renders rows action-disabled.

## Resolved open questions (from the issue)

Opening a row delegates to the shared existing-session navigation callback. A closed local project
is validated and opened before selecting its existing task; no new draft is created. Remote targets
require their exact live attachment and never probe the local filesystem. An unavailable project
leaves Settings visible with an error. Archived disables Pinned and ignores its predicate while
retaining the Active preference for the return transition.

- **Inline rename for running sessions** — allowed (§7); auto-title overwrite caveat accepted.
- **Sorts** — default Updated desc; server sorts on Updated/Created, client sort on Name; no Status sort in v1.
- **Hosting** — `sessions` section in the `dataAndStats` group of the Settings page (2026-10-17 redesign), not a main-window tab; not persisted (§1).
