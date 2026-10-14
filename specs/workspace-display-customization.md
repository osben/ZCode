# Workspace Display Customization

## Goal

Let a user give an open project a shorter sidebar name and an optional color, without changing its
workspace path, identity, or task-group settings.

## Scope

- The project rows in the main Projects section of the desktop and web sidebars.
- A project menu opens a dialog with a display name and one optional color from the existing task
  group palette.
- The display name defaults to the folder-derived label. Clearing it restores that label.
- The selected color tints the workspace icon. Clearing it restores the default icon color.
- Reset clears both custom values.
- Conversations, collapsed sidebar rail, mobile remote home, and task-group colors are unchanged.

## State and persistence

- The renderer store is the single owner of display customization. It stores only the local display
  name and color; workspace identity and execution continue to use the existing workspace tab.
- Each entry is keyed by `buildTaskWorkspaceKey(workspacePath, workspaceIdentity)`, so a remote
  workspace cannot collide with a local workspace at the same path.
- The store persists in the current client’s `localStorage`. Desktop and web clients do not sync
  these preferences across devices.
- The dialog seeds its drafts from the effective current entry whenever it opens. Save writes both
  fields; reset clears both fields.

## Acceptance scenarios

1. Rename a project, close and reopen its menu, and verify the chosen name remains visible.
2. Choose a color and verify the project icon uses that color; clearing the color restores the
   default icon color while retaining a custom name.
3. Clear the name and verify the folder-derived label returns while the chosen color remains.
4. Reset customization and verify both the folder-derived label and default icon color return.
5. Give local and remote workspaces with the same path different names/colors and verify each row
   uses its own values.
6. Verify changing a project color does not alter the colors of task groups within that project.

## E2E Evidence

- `WSPC-DISPLAY-01` in `packages/desktop/test/e2e/workspace-sidebar-project-controls.test.ts` saves
  a custom name and color, verifies both in the row, then resets and verifies the default display.
