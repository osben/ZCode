# Workspace sidebar customization

Workspace pins are owned by `ForkWorkspacePinRepo` in the shared tasks database. Its additive fork migration is identified in the shared migration ledger and must check the ledger and checksum inside the same `BEGIN IMMEDIATE` transaction that creates the table and records the migration. Concurrent window Hosts must safely converge on one migration row. Closing the repository during asynchronous initialization invalidates that initialization before it opens a database connection. An adapter closes only a repository it created; an injected repository remains owned by its host.

The UI loads pinned workspace keys before exposing pin and unpin actions. While the initial request is pending, users cannot mutate pin state from a stale empty snapshot. Per-workspace pin writes are serialized; if a write fails, the UI returns to the latest confirmed persisted value after that workspace's pending writes settle. A failed initial read settles the loading state and leaves the list usable as unpinned.

Display names and icon colors are per-workspace preferences stored in the `zcode-workspace-display` localStorage record. A write reads the latest persisted record, changes only the target workspace entry, and publishes the merged state to the current store. Other open windows reload this record when they receive its `storage` event. If storage access or persistence fails, reads fall back to empty preferences and writes still update in-memory state. Local changes that could not be persisted remain overlaid on later storage reads, including removals, until a successful write persists them.

Saving the prefilled folder label without an existing custom name keeps the display name unset, so future folder or remote labels remain dynamic. A non-empty custom name is trimmed; an empty name clears the custom name.

Changes to saved preferences from another window do not reset unsaved name or color drafts while the customization dialog remains open. Drafts are seeded when the dialog opens or switches to another workspace.

Pressing Enter saves the customization dialog only when the input method is not composing a candidate. E2E scenarios that require the two-workspace startup fixture must be registered in both the full warmup fixture list and the small two-workspace list.

## Project rows after the project-tree sidebar (3.16.1 sync)

The sidebar is organized by projects (`VirtualProject`), not workspace tabs. The display-preference record
`zcode-workspace-display` is reused unchanged, but project rows key their entry as
`project:<hostId>:<projectId>` (`buildProjectDisplayKey`) because a project can own several roots and has
no single workspace key. The preference stays a fork-local browser preference: it is never written to
`setting.json`, the project database, or upstream migrations (see AGENTS.md "Shared Databases and Fork
Divergence"), so it is per-browser/profile and not synced across devices.

The color is edited inside the upstream `ProjectEditor` (the "Edit project" dialog) through
`ProjectColorField`, next to the project name, and is saved together with the name: a successful
`saveProject` writes the draft color under the saved project's key (an untouched color field writes
nothing). There is no separate Customize menu item or dialog, and no display-name override: the project
name edited there is the only name. The row tints the project folder icon with the chosen color (same
`WORKSPACE_ICON_COLOR_CLASS` palette as before the sync). Projects that cannot be edited (offline or
legacy single-root entries) have no edit entry and therefore no color editing. The display-name field of
the store is kept for the older per-workspace record but is not used by project rows.
