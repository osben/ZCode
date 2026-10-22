# UI pins: retire fork workspace pins, adopt upstream project pins

Status: spec (written before code). Branch `claude/ui-parity-pins`. Ledger: `specs/upstream-sync-final-ledger.md`.
Upstream: `0a1fc56d`. Fork base: `aac4755666d09fdcd70272fcf063c077a639015f`.

## Current state (verified in the tree)

| Item        | Fork (origin/integration)                                                                                                                                                     | Upstream (0a1fc56d)                                                                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin storage | `fork_workspace_pins(workspace_key PK, pinned_at)` in `tasks-index.sqlite`, migration `9001_fork_workspace_pins` (`packages/services/src/session/forkWorkspacePinRepo.ts`)    | `projects.pinned` + `projects.pinned_at` in project storage (`packages/services/src/project-storage/schema.ts`)                                                                                                               |
| Pin writer  | `zcodeTaskService.setWorkspacePinned` / `listPinnedWorkspaceKeys` (adapter `zcodeTaskServiceAdapter.ts` ~3540)                                                                | `projectService.saveProject({ id, pinned })` (`packages/services/src/project/index.ts`), used by `ProjectSidebarNode.tsx`                                                                                                     |
| Pin UI      | No fork UI writer is active. `WorkspaceSidebar.tsx` no longer calls the pin methods; `workspaceSidebarProjectPins.test.ts` is deleted (ledger row UI2-SIDEBAR-PINS resolved). | `project-sidebar/ProjectNodeContent.tsx` pin/unpin menu                                                                                                                                                                       |
| Pin order   | Not stored. The fork's manual tab order lives in the sidebar preference (`lib/workspacePinPreference.ts`).                                                                    | Upstream CONTRACT (`project-sidebar/CONTRACT.md` line 65): display order is owned by the existing sidebar preference; the server stores no UI order for pins. `projects.position` is the project list order, not a pin order. |

Consequence: the fork's pin table has no ordering field to carry over, and the pin order was never a
server fact. The migration only needs to set the upstream boolean.

## Decisions

1. The upstream boolean `projects.pinned` (via `projectService.saveProject`) is the only pin writer.
2. `fork_workspace_pins` is kept, never dropped, never written again. Its reader is used only by the migration.
3. The migration is one-time and idempotent. Its done-marker is a row in the shared
   `tasks_schema_migration` ledger with id `9002_fork_pins_to_projects` and a checksum of its
   definition string (fork-owned, additive, no upstream ids touched).
4. Upstream migration definitions, `schema.ts` DDL, and `project-storage` schema are not changed.
5. `setting.json` is not used.

## Migration algorithm

Input: each `workspace_key` from `fork_workspace_pins`, read once.

For each key:

| Case                                                                   | Detection                                                                                     | Handling                                                                                                                                     | User-visible loss                                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A. Key is already a root of a project (same local host)                | `project.roots` contains `normalize(key)`                                                     | Set `pinned=true` via `saveProject({ id, pinned: true })`. No new project.                                                                   | None                                                                                                      |
| B. Key is an existing absolute directory, no project yet               | `stat(key).isDirectory()` and no root match                                                   | `saveProject({ roots: [key], pinned: true })`. The project gets the default name.                                                            | None. The project is new, so the workspace now appears as a project.                                      |
| C. Key is an absolute path that no longer exists or is not a directory | `stat` fails or not a directory                                                               | Skip, record in the migration summary log (`info`, scope `project-pins-migration`). Row kept.                                                | The pin is lost. The project service refuses `project.directory-required`, so the pin cannot be recorded. |
| D. Key is a remote identity (not an absolute local path)               | Key does not start with `/` (or a drive letter on Windows)                                    | Skip and log. Remote projects are owned by their Host; registering needs the remote connection, which is not available at startup. Row kept. | The pin is lost for remote workspaces. Re-pin from the project menu once the remote project shows.        |
| E. Duplicate keys for one project (trailing slash, two identities)     | Two keys normalize to the same root                                                           | Pin once.                                                                                                                                    | None                                                                                                      |
| F. Two projects share a root (already invalid in upstream)             | Not possible through saveProject; if found, pin the first match by `project_id` order and log | Log only                                                                                                                                     | Second project not pinned                                                                                 |

Pin order: not migrated, because it was never stored as a server fact (see table above). Migrated
pins sort by the sidebar's existing preference, same as upstream pins.

Ordering and atomicity: each `saveProject` is a single write. The marker is written only after all
keys are processed. A crash between them re-runs the migration, and every case above is idempotent
(a pinned project stays pinned, a registered project is found by root in case A on the second run).

Marker: `tasks_schema_migration(id='9002_fork_pins_to_projects', checksum=sha256(MIGRATION_DEF), time_applied)`.
A marker with a different checksum fails loudly, as `ForkWorkspacePinRepo` does for `9001`.

## Retired surface (PR1)

- `zcodeTaskService.setWorkspacePinned` and `listPinnedWorkspaceKeys` are removed from the
  service contract and the adapter. The UI has no caller left.
- `ForkWorkspacePinRepo.setWorkspacePinned` stays callable by its own tests only; the migration
  test seeds rows through direct SQL instead.
- `workspaceSidebarProjectPins.test.ts` is deleted, not kept skipped. It asserted fork-only sidebar
  source contracts (`WorkspaceSidebar.tsx` / `WorkspaceSidebarItem.tsx` pin rendering, drag clamping,
  `listPinnedWorkspaceKeys` / `setWorkspacePinned` persistence) that the project sidebar no longer has.
  Its dead leftovers went with it: `lib/workspacePinPreference.ts` and its test, the
  `TID_WORKSPACE_PIN_DIVIDER` / `TID_WORKSPACE_TOGGLE_PIN` test ids, and the
  `workspaceSidebar.pinProject` / `unpinProject` / `pinFailed` locale keys (no src usages).
  The pin/unpin action is the upstream `projects.pinned` write via `saveProject`.

## Acceptance tests (written first)

1. Migration sets `pinned=1` for case A and creates a project for case B, with `pinned=1`.
2. Case C and D rows are skipped, logged, and remain in `fork_workspace_pins`.
3. Running the migration twice gives the same project rows (idempotent), and the marker prevents the second run from writing.
4. A crash after the project writes but before the marker is written is recovered by a re-run (no duplicate projects).
5. A marker with a different checksum fails loudly.
6. Upstream build opening a DB with `9002_fork_*` rows works (ledger ignores unknown ids).

## Out of scope

- The fork's sidebar pin UI is already gone. Upstream's project pin UI is the replacement, and it is
  part of the sidebar adoption in PR2.
- Dropping `fork_workspace_pins`.
