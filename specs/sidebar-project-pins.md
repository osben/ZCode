# Sidebar Project Pins

## Problem

The left sidebar "Projects" section lists one row per open workspace. With many projects, frequently
used ones are buried, and the only ordering tool is manual drag reorder. Tasks already support
pinning (a global "Pinned" section above the projects); projects do not.

## Goal

Allow pinning projects (workspaces) so they stay at the top of the Projects section.

## Scope (V1)

In scope:

- The full Projects section of the main left sidebar (the `SortableWorkspaceSidebarItem` list),
  in both the desktop app and the web client. Each client keeps its own pin state.

Out of scope (deferred):

- Collapsed sidebar rail (icon strip) — pins do not affect it.
- Mobile web-remote home and the browser remote-control task index — they render their own
  workspace lists and cannot read another device's local storage.
- Cross-device sync of pin state (would require moving state into `AppSettings`).
- The Conversations section (`workspacePurpose: "conversation"`) — pinning does not apply.
- Pinning task groups (the in-workspace colored groups) — unrelated concept.

## Product Rules

1. **Pin state is per workspace identity.** The key is `buildTaskWorkspaceKey(workspacePath,
workspaceIdentity)`, so a remote workspace with the same path as a local one never collides.
2. **Pinned projects render first** inside the Projects section, in a stable partition of the
   current manual order: `[pinned in manual order, then unpinned in manual order]`. A hairline
   divider separates the two blocks when both are non-empty. Pinned rows show a small pin glyph.
3. **Pin/unpin is an explicit menu action** in the project row's "more" (⋯) menu:
   "Pin project" / "Unpin project". Drag never changes pin state.
4. **Drag is clamped to the block** (Chrome pinned-tabs behavior): a pinned project can be
   reordered only within the pinned block, an unpinned one only within the unpinned block. A drop
   across the boundary is a no-op (the row snaps back); nothing is implicitly pinned or unpinned.
5. **Unpinning returns the project to its manual-order position** among the unpinned block
   (the store order is the single source of truth; pinning only partitions the display).
6. **Persistence is per client backend, in the shared tasks database**: the `fork_workspace_pins`
   table in `~/.zcode/v2/tasks-index.sqlite` (one row per pinned `workspaceKey`). This follows the
   fork DB rules (project `AGENTS.md`, "Shared Databases and Fork Divergence"): a `fork_`-prefixed
   table created by the additive migration `9001_fork_workspace_pins`, tracked in the existing
   `tasks_schema_migration` ledger with its own checksum, and never touching upstream migration
   definitions. Rows for removed projects are harmless leftovers.

## State Ownership

- Owner: `ForkWorkspacePinRepo` (`packages/services/src/session/forkWorkspacePinRepo.ts`), a
  sibling repository in the `OffPeakTaskRepo` pattern that opens its own connection to
  tasks-index.sqlite and applies the fork migration itself. Single read
  (`listPinnedWorkspaceKeys`) and single write (`setWorkspacePinned`) path.
- Exposure: two methods on `IZCodeTaskService` (sidebar shell state rides the task-shell service):
  `listPinnedWorkspaceKeys(): Promise<string[]>` and
  `setWorkspacePinned({ workspaceKey, pinned }): Promise<void>`. Calls always go through the
  base (local host) services — `useBaseWorkspaceServices()` — never through a remote workspace
  connection, because the project list and its pins belong to the client that renders the sidebar.
  Remote-workspace tabs are pinned by their `workspaceKey` (identity-qualified) in the same local
  table.
- Holders: `WorkspaceSidebar` keeps the current `Set<string>` in React state, loaded asynchronously
  on mount (and when base services arrive); toggling applies optimistically and rolls back with a
  toast when the write fails. Until the load resolves, the sidebar renders the manual order (pins
  then partition it); the local query resolves in milliseconds, so the reorder flash is negligible.
- Ordering source of truth stays the tab store; the pin set only partitions the rendered order.
- The mobile home / remote-control surfaces do not consume these methods yet (V1); exposing them
  through the remote-control RPC proxy is a follow-up.

## Interface

- Service: `IZCodeTaskService.listPinnedWorkspaceKeys()` / `.setWorkspacePinned(params)`
- `orderWorkspaceTabsByPinned(tabs, pinnedTabIds)` → stable partition for rendering
- `isWorkspaceDragAcrossPinnedBoundary(pinnedTabIds, activeId, overId)` → clamp predicate used in
  `handleWorkspaceDragEnd`
- `WorkspaceSidebarItem`/`SortableWorkspaceSidebarItem` gain `isPinned?: boolean` and
  `onToggleWorkspacePinned?: (pinned: boolean) => void` props; the menu item renders only when
  the toggle is provided.

## Acceptance Scenarios

1. Pin via the row menu → the project moves into the top block with a pin glyph; the divider
   appears; the state survives an app reload.
2. Unpin → the project returns to its manual-order position in the unpinned block; the divider
   disappears when the pinned block empties.
3. Drag a pinned project within the pinned block → order changes and persists (existing
   `reorderWorkspaceTabs` path).
4. Drag a pinned project below the boundary (or an unpinned one into the pinned block) → no
   reorder happens.
5. A remote workspace and a local workspace sharing one path → pins are independent.
6. Task pinning, the global "Pinned" tasks section, and the Conversations section are unaffected.

## E2E Evidence

- `WSPC-PINS-01` in `packages/desktop/test/e2e/workspace-sidebar-project-controls.test.ts` pins a
  second open project, verifies it moves to the top block with the divider and indicator, then
  unpins it and verifies the indicator and divider disappear.
