# Virtual Project Design

Full history: `git show 37b98ff8:docs/superpowers/specs/2026-09-09-virtual-project-design.md` (long verification logs, per-round diaries and measurement tables were dropped from this version).

## Later rulings that override parts of this document

- New-draft model/permission defaults and the lifecycle of the unclassified pending-send directory follow
  [Unified design](../../ui/project-task-draft-lifecycle.md): isolated per client, target host and project ID;
  the unclassified pending directory is consumed after the first send is admitted. All other organization and
  execution-directory rules here still apply.
- 2026-10-10: remote single directory, no Host grouping, project before session and unified controller-side
  ordering follow [the integration spec](2026-10-10-session-manage-upstream-integration.md). Historical process
  notes here that conflict with it are not implementation basis.
- 2026-10-13: Project and Group coexist. The filter menu's "group by" returns; Group is a controller-saved,
  cross-project, cross-device organization view that decides neither execution directory nor project
  membership. First upgrade keeps workspace -> Project and drops Group -> Project; the old group tables stay
  authoritative. No automatic workspace-to-group and no forced archiving on group queries. Behavior and
  acceptance: [Task grouped view](../../ui/task-grouped-view.md). The old rulings below about merging Group,
  two view modes, F9/F10 manual Group -> project, M6 group conversion and group API retirement are replaced.
  Dev databases that already ran the old conversion are not cleaned up; no migration ID or SQL checksum changes.
- 2026-10-15 (remote legacy tasks into projects): the desktop-controlled legacy remote workspace list lives only
  in the controller's `setting.json` (`kind=remote`); the remote Source Server's own `lastWorkspaceSession` is
  empty. F8/M5 originally read only the database-holding Host's own list, so first remote migration created 0
  projects, all old sessions were unclassified, remote unclassified sessions never reach the sidebar, and
  re-selecting the old directory could only create an empty project. Now an F8 exception: when the holding owner
  is not local, first migration also creates single-root projects from historical task directories and
  attaches the tasks. Databases that already ran `0005_projects` are neither re-run nor repaired.
- 2026-10-19 (several holding owners on one machine): local desktop (owner=local) and Source Server
  (owner=server) share `~/.zcode/v2/tasks-index.sqlite`. `0005_projects` runs once per database and writes only
  the first opener's host row; a later owner without its own `hosts` row failed `projects.host_id` foreign keys on
  project creation. Each owner now idempotently inserts its own host row (`INSERT OR IGNORE`) in `reconcileLegacy`
  on every start; no schema, migration ID or checksum change, no change to any task's `host_id` or project.
  Open limitation: legacy `host_id IS NULL` rows are claimed by the first processor (local judges by
  `workspace_key` shape; server ignores the key and claims all), so local sessions may be claimed by the Source
  Server and SSH sessions by the local host under the ssh address host. The claim rule and correction of
  wrongly-claimed data need a separate ruling.

Global invariant (not repeated per section): every feature here keeps the desktop-continuous /
mobile web-remote-replayable split, the existing owner/lease/CommandInbox paths and the shared-host attachments, and
adds no schema, migration, stream, accepted queue or timer unless the section says so. Mobile reuses the same
UI/service path as desktop.

Status: **in implementation** (2026-09-10). §3 is the decision record (aligned item by item with the maintainer,
2026-09-09 to 09-10); §4 onward expands the plan from those decisions. If implementation conflicts with a
decision, the decision wins and this document is updated. Scope, tests and progress:
[implementation log](../plans/2026-09-10-virtual-project-implementation.md).

## 1. Product conclusions (input)

1. Group and Project merge; the product keeps only Project.
2. A Project is no longer one Folder Path. It is a container organizing Sessions by topic with 0..n local
   folders (Repo / Worktree / Remote Workspace are out of scope for this phase).
3. The UI uses the traditional "project / folder" hierarchy, not Chrome-style tab groups.
4. A Session can be created without a Project (unclassified) and dragged in or out later.
5. Public group/project management entry points are removed.
6. Local and remote Sessions are not mixed in management; remote projects are listed flat with local ones and
   the device is only identity and connection information.
7. The database rework is the core: converge on a single source of truth; migrations are downgradable,
   cross-version and backed up first.

## 2. Current state (investigation)

### 2.1 The sidebar list has four data sources

```text
setting.json (~/.zcode/v2/settings/setting.json)
  ├─ recentProjects: string[]              local path history (max 10)
  └─ lastWorkspaceSession: Entry[]         the real sidebar workspace list (order = sidebar order)
       ├─ {kind:"local",  workspacePath, workspacePurpose}
       └─ {kind:"remote", workspacePath, workspaceIdentity, target(snapshot), lastConnectionStatus...}

tasks-index.sqlite (~/.zcode/v2/tasks-index.sqlite, note the "s")
  ├─ tasks                      title / searchable_text / pinned / archived / deleted / unread / status
  │                              PK = (workspace_key, task_id)
  ├─ task_groups                 group metadata (title/color)
  ├─ task_group_members          task <-> group (one group per task)
  ├─ task_group_view_node_orders top-level mixed order
  ├─ task_group_workspace_bootstraps  one-shot "auto-group by workspace" marker
  ├─ off_peak_tasks              off-peak tasks
  └─ automations / automation_runs   scheduled tasks

cli/db/db.sqlite (~/.zcode/cli/db/db.sqlite, CLI-owned, proper migration runner)
  └─ session / message / part / local_setting / session_task_link ...  conversation content and CLI state

renderer localStorage
  └─ view preferences, collapse state, workbench split groups (unrelated to sidebar groups)
```

The UI joins client-side in `useGroupedTaskView` / `useWorkspaceTaskLists`: `listGroupedTaskViewStructure` +
`listTasks/listPinned/listArchived/...` + the v4 `sessions-index` live frames, assembled in memory. This is
the root cause of the bugs.

### 2.2 `workspace_key` pollution

- Definition: `workspaceKey = workspaceIdentity?.trim() || workspacePath` (`packages/shared/src/task-realtime-core.ts:92`).
- Remote rows store e.g. `remote:ssh:dev.internal:22:developer:/work/demo`, i.e. the ssh account is in the key.
- The same definition also derives `~/.zcode/v2/sessions/{hash}`, `agent-config/{provider}/{hash}`, the CLI memory
  directory hash, the web-remote bridge key, and the `workspaceKey` field of automations/off-peak. Changing the
  key changes these derived hashes, which then need migration or a compatibility map.
- The remote `zcodeTaskService` is an RPC proxy to the remote Host and writes the remote machine's own
  `tasks-index.sqlite`; the local machine holds no index copy of remote sessions.

### 2.3 Existing migration infrastructure

- App side: no schema version and no "last run version". sqlite uses `CREATE TABLE IF NOT EXISTS + ensureColumn`;
  `setting.json` migrates in place with a zod preprocess chain.
- CLI side: `schema_migration(id, checksum, app_version)` + 18 sequential migrations
  (`apps/zcode-cli/packages/adapters/src/storage/session-store/migration-runner.ts`); the pattern is reusable.
- Backup/compression: `yazl` (exportLogs, feedback), `backupCorruptFile`, `copyDataDirectory` (basedir switch)
  exist. There is no disk-space check.
- Startup chain: main `whenReady` -> `mainSettingService.get()` -> spawn cron scheduler -> create window -> Host
  `InitLocal` first opens sqlite. The renderer has `RootStartupLoading` (`shouldShowRootStartupLoading`) which can
  take an `isMigrating` input.

### 2.4 Per-directory agent configuration (current root rules)

| Config | User level | Project-level path | Resolution root | Multi-level merge |
| --- | --- | --- | --- | --- |
| settings (model/permission/ui/storage) | `~/.zcode/cli/config.json` | `<dir>/zcode.json`, `<dir>/.zcode/config.json` | cwd up to git root, root first, cwd last | deep merge, later wins |
| MCP servers | same `mcp.servers` | same | same | by name: system -> project -> **user** -> env -> cli (user overrides project); project source marked untrusted |
| hooks | `config.json.hooks`, directly executable | same | same | project level only yields a hookCandidate through workspace hook trust |
| skills | `~/.zcode/skills`, `~/.agents/skills` | `<dir>/.zcode/skills`, `<dir>/.agents/skills` | every level from cwd to git root | all visible; same name: first found wins (user shadows project) |
| commands | `~/.zcode/commands`, `~/.agents/commands` | `<dir>/.zcode/commands`, `<dir>/.agents/commands` | same as skills | same name first wins + duplicate diagnostic |
| subagents | `~/.zcode/cli/agents/*.md` | `<cwd>/.zcode/agents/*.md` | **cwd level only, no walking up** | Map by name, later load overrides (project overrides user) |
| AGENTS.md | `~/.zcode/AGENTS.md` | `<dir>/AGENTS.md` | cwd up to git root, **first hit only** | user + workspace concatenated |
| agent-written memory | - | `~/.zcode/cli/memories/projects/<slug>-<sha(identity‖path)>/memory` | by workspaceKey hash | one per directory |
| permissions ruleset | - | sqlite `local_setting(scope=project, scope_id=projectIdFromDirectory(cwd))` | exact cwd | one per directory |
| plugins | `~/.zcode/cli/plugins` + `config.json` | plugin section of project config | same as settings | `resolvePluginConfigSources` |
| workspace-config topic (settings page) | - | - | key = `workspace-config/<workspaceId>` | one per workspace |

The CLI has an unimplemented multi-workspace draft, `apps/zcode-cli/docs/design/v2/multi-workspace.md`
(`WorkspaceScope{primaryRoot, additionalRoots}`, `--add-dir`, roots in `local_setting(scope=workspace)`); it is
superseded by B2 below.

## 3. Decision record (2026-09-09 to 09-10, maintainer)

### 3.1 Concepts and boundaries

| # | Question | Decision |
| --- | --- | --- |
| A1 | Sidebar forms | Form 1 = "Projects / Tasks" two blocks; form 2 = time-ordered (timeline) |
| A2 | Real directory as a visible node | No; it is only a root attribute of the project |
| A3 | Public management removed | Remove the Group/Project view switcher, group management menu and new-group entry, central management page; the whole toolbar (figure 7) goes; sorting (by time / by project) moves to the "Projects" title context menu; timeline keeps its implementation but its entry is hidden; archive entry and expand/collapse-all icons are not kept (the "group by" filter returns per the 2026-10-13 ruling) |
| A4 | View modes | Only project tree + timeline |
| A5 | "Tasks" area | Unclassified sessions: `project_id IS NULL`, no restriction on bound directory; a session always has a workspace; a global new task creates `~/.zcode/workspace/<unique dir>` as cwd; a session inside a project can only be dragged to another project, not out |
| A6 | Same real directory in several projects | Allowed |
| A7 | New session in a 0-root project | Auto-create `~/.zcode/workspace/<timestamp>`, add it as a root of the project and make it primary |
| A8 | Session bound directory (cwd) | Never changes after creation |
| A9 | cwd of a new session in a project | Fixed to the primary directory, no choice offered |

### 3.2 Run model and agent-side configuration

| # | Question | Decision |
| --- | --- | --- |
| B1 | Run model | One cwd (session bound directory) + the project's current roots other than that cwd as additional directories |
| B2 | CLI aware of projects | No, it only receives a directory list; the `multi-workspace.md` draft is void and this document redesigns the data structures |
| B3 | AGENTS.md | Only the session-bound directory chain |
| B4 | skills / commands | All roots available; same names coexist with source labels; the model also sees skills of all roots |
| B5 | subagents | Loaded from all roots, same names coexist with source labels |
| B6 | MCP (project-level `mcp.servers`) | Only the session-bound directory chain |
| B7 | settings (model/permission/ui/storage) | Only the session-bound directory chain |
| B8 | hooks | Execution runs only the session-bound chain; settings-page display and trust follow the real workspace |
| B9 | plugins project-level config | Effective only from the session-bound chain; other roots are only scanned for display in settings |
| B10 | permissions ruleset | By session-bound directory |
| B11 | agent-written memory | By session-bound directory |
| B12 | Tool path policy / sandbox | All roots readable and writable |
| B13 | composer @file | All roots can be @-ed, root name appended to the file name |
| B14 | Principle | Keep the CLI config chain by workingDirectory; additional directories feed skills, subagents and writable scope, and the environment prompt lists paths only |
| B15 | When roots changes take effect | When the session's runtime instance is next rebuilt; plain subscribe, resubscribe and network reconnect do not refresh the instance's directory scope (see 4.3.1) |
| B16 | Same-name skill source label | CLI assigns a qualified name (`<rootName>/<skill>`) used by both prompt and UI |
| B17 | Additional-directory source | Host resolves the directories uniformly for create / explicit resume / V4 subscribe cold resume; ordinary tasks store no creation-time directory snapshot (see 4.3.1) |
| B18 | Agent management page / scheduled & off-peak | Workspace switching in agent capability management uses the real workspace; scheduled tasks, off-peak tasks and Bots use virtual projects |

### 3.3 List and interaction

| # | Question | Decision |
| --- | --- | --- |
| D1 | Pinning | Keep the global pinned session area; projects can also be pinned, into the global pinned area below sessions; remote sessions can be pinned |
| D2 | Drag | Session across projects, from "Tasks" into a project, project reorder; no manual in-project ordering and no multi-select drag; when the target project does not contain the session's real workspace a dialog confirms adding it |
| D3 | New-task entries | The project row creates a draft in that project's primary directory; Cmd/Ctrl+N and top-left New inherit the current session's or draft's project, and only without a project create an unclassified draft in an auto-created `~/.zcode/workspace/<unique dir>`; New in the task section explicitly creates an unclassified draft |
| D4 | Project context menu | Edit project, pin, delete project; editable remote projects match local ones and do not show "Remove from this machine" or "Add remote project"; "Remove from this machine" shows only when not editable (offline / error, legacy single root) (2026-10-16) |
| D5 | Web / mobile remote sidebar | Both show the project hierarchy |
| D6 | Right-side workbench split group | Unrelated to this work, untouched |

2026-10-15 sidebar creation and expansion rules:

- The new buttons of the project and task sections and the project row's new-session button are right-edge
  aligned; layout is shared by themes, desktop and mobile.
- Left of the project section's new button there is "Collapse all projects / Expand all projects": if any
  expandable project is expanded, collapse all, otherwise expand all; pinned projects are included. Offline
  projects stay non-expandable and trigger no connection. The button is disabled when nothing is expandable.
- The batch action updates the existing preference indexed by Host + projectId in one write, keeping the
  section's own collapse, sort and current session, and persists across refresh.
- The current session's project comes from the Host task index by exact `workspaceKey + taskId`, never by guessing
  from cwd; the current draft reads `draftProjectId`. An explicit projectId (including null) wins. Desktop and
  mobile resolve intent at the same entry; mobile still has the bridge prepare the directory and hand off. If
  navigation changed after the async read, the result is discarded.

```text
shortcut / top-left New -> current session or draft -> project membership -> Host prepareSession -> draft
New in task section     -> explicitly no project ────────────┘
collapse / expand all   -> existing expanded preference -> project row display (no navigation, no connection)
```

### 3.4 Create / edit / delete

| # | Question | Decision |
| --- | --- | --- |
| E1 | Delete project | Soft-delete the container: row marked deleted, sessions keep `project_id`, CLI database untouched (messages, titles as they are); timeline still shows them, they open and can be dragged to other projects; deleting a remote project while offline only removes the local entry (G5) and does not run this remote soft delete |
| E1a | Restore | Only entry: when creating a project whose roots set equals (ignoring order and primary) a deleted project of the same host, offer restore; restore = `deleted` to 0 and update name/primary from the form, sessions come back unchanged; declining creates an empty project; re-adding a locally removed remote project is not a restore of a remote project |
| E1b | Hard delete | Not provided; soft-deleted projects are kept forever |
| E2 | Remove a root | Sessions bound to that directory stay in the project |
| E3 | Running confirmation | Deleting a project / removing a root shows no confirmation |
| E4 | Project name | Follows the first root's name unless hand-edited (`name_overridden`); unique within a host, duplicates get a numeric suffix; no root and no name is called "新项目" (New project) |
| E5 | Roots validation | Parent/child nesting allowed; exact duplicates deduplicated; nonexistent directories rejected |

#### 3.4.1 New projects go first by default (2026-09-15)

An explicitly created, restored or added project takes the first slot of its display area for the current
controller; local and remote are mixed uniformly. The preference key is (hostId, projectId); reconnect, refresh
and rename keep the position. Pinned and normal areas are separate; dragging does not change `pinned` and writes
no remote `position`.

The single ordering owner is the Host project repository's `projects.position`. The existing create write
transaction assigns `min(position) - 1` for that Host (0 when the Host has no project); history rows are not
renumbered, UI time is not used, and no reorder is sent after save. Failure rolls back with the same
transaction; under serial admission a later commit naturally sorts first, and reads/restarts reuse the persisted
order. No schema or migration change; local and remote repositories share the rule.

```text
save new project -> Host atomically assigns first position and writes -> readTree -> desktop / Web / mobile list
manual drag      -> existing reorderProjects -> the same projects.position
```

PRO01 (accepted/pending): with existing projects, creating a new project puts it first in the sidebar at once and
after refresh, using the real creation path of `ui-shell/manual-review/pending/project-native-directory-picker.test.ts`.
Repository unit tests cover empty database, consecutive creates, create after manual reorder, edit/restore order
preservation and Host isolation. Local E2E does not claim real mobile/remote transport (desktop E2E passed; real
remote/mobile and Windows/Linux GUI not run). Stays pending.

### 3.5 Data ownership

| # | Question | Decision |
| --- | --- | --- |
| C1 | Single source | Both databases coexist, every field has one owner: **conversation facts belong to the CLI, organization state to the Host** |
| C2 | CLI is the only writer of db.sqlite | Existence and soft delete, title + title_source, time_created/updated, content, goal, fork, trace, last_outcome |
| C3 | Host is the only writer of the app database | `project_id`, pinned, archived, unread + CAS, `sort_order`, projects / roots / hosts / scheduled / off-peak; this organization state exists only in the original columns, no copies. CLI facts live in `cli_*` mirror columns written only by taskIndexSyncer; the Host no longer writes any derived time/status. Old columns `deleted`, `title_overridden+title` are redefined as the "Host's delete / rename intent" to be handed to the CLI (see 7.4) |
| C4 | Offline title rename | Through the CLI renameSession command, spawning the CLI if needed; mirror afterwards |
| C5 | Archive | Host only; CLI deletes the dead column `time_archived` (deprecated by migration marker, not physically dropped) |
| C6 | Delete | CLI soft delete: new `time_deleted`, deleteSession now means delete; cold seed / listSessions / TUI filter it; app `deleted` = Host delete intent (hidden at once, pending handoff), `cli_deleted` = CLI confirmed; display rule `deleted OR cli_deleted`. Absence from a snapshot is not deletion and must be confirmed through `sessionsIndex/reconcile` (see 5.2, 7.4) |
| C7 | End-of-turn result | CLI adds `last_outcome` and summary fields; app task_status becomes a mirror |
| C8 | searchable_text | Unchanged |
| C9 | tasks-index vs sessions-index | App database = row set + organization state + read-only mirror of CLI facts; sessions-index = CLI-authoritative live activity stream |
| C10 | App database shape | Upgrade the existing `tasks-index.sqlite` in place with versioned migrations |
| C11 | Primary key | Physical PK stays `(workspace_key, task_id)`; add `UNIQUE(host_id, task_id)` as logical key; add a hosts table |
| C12 | Derived directory hashes | Left untouched |
| C13 | Remote organization state | The remote app database holds the authoritative project content, roots and session membership; the local machine persists hosts connection records, the list of added remote-project entries and cached basics (name / roots / primary). The entry list belongs to the local machine, caches do not replace remote organization state; not-connected projects cannot expand; offline delete removes only the local entry and cache (see 4.2.1) |
| C14 | Project fields | Name, roots, primary, pinned, order, soft delete; no color / icon / archive / description |
| C15 | Top-level order | Project area and task area are independent, not mixed |

### 3.6 Compatibility and migration

| # | Question | Decision |
| --- | --- | --- |
| F1 | Downgrade discipline | Both databases only add, never delete or change old column semantics; Host-owned organization state (`pinned/archived/unread/title_overridden+title/deleted` intent) exists only in the original columns, not copied; CLI facts live in `cli_*` mirror columns; every start reconciles "old-column intent vs mirror" over the whole table (see 7.4), not just NULL fill; `schema.baseline.sql` + CI add-only diff; e2e covers upgrade -> downgrade (including edits to existing rows) -> upgrade again |
| F2 | Compatibility retirement | Three phases, no permanent baggage: V1 **reads only new columns/tables**, old columns write-only (dual write only for pre-V1 versions); V2 writes `schema_floor=V1`, refuses to open below the floor, stops dual write, the setting.json derived write-back and NULL fill, and upserts with `ON CONFLICT(host_id, task_id)`; V3 physically drops old columns, the four old group tables, CLI `time_archived`, and rebuilds the PK as (host_id, task_id). V2->V1 and V3->V2 downgrades stay fully usable |
| F3 | First placement of sessions without membership (first-migration leftovers, created during downgrade, newly discovered by the CLI, ...) | Judged once, at first migration or first discovery: if the bound directory is a root of exactly one non-deleted project on the same host, attach to it; zero or several matches keep `project_id = NULL`, shown in the task area. No primary-directory priority, no auto-created projects, no cwd change. Global new tasks stay explicitly unclassified; an already-judged NULL is legal organization state and later starts, reconciles or new projects never re-place it |
| F4 | Group add/delete/edit during downgrade | Ignored; group -> project happens once, on first upgrade (superseded by the 2026-10-13 ruling) |
| F5 | setting.json | Keep dual-writing lastWorkspaceSession / recentProjects; remote entries derive from the local machine's retained remote-project entries, removing an entry cleans the matching old item, and the full remote project list never regenerates them |
| F6 | Execution place | Synchronously after main whenReady and before starting the Host; failure is fail-closed (retry / open backup folder); no second implementation |
| F7 | Backup | Purpose: only recover to pre-upgrade state if migration fails or corrupts the database; not a downgrade mechanism nor a general data safety net; normal runs only produce, never consume. Method: generic table-level backup (see 7.1), only when migrations are pending, before the transaction, export the `touchedTables` declared by those migrations table by table in one read transaction to `~/.zcode/backup/<version>-<time>/<db>.sqlite`, write backup.json, keep 2 copies; no whole-database snapshot (measured: whole 770MB/12s, gzip 160MB/19s; table-level CLI 1.9MB/70ms, tasks-index 14MB/165ms). If the current volume lacks space, try other writable volumes in turn; if none fits, skip with a notice; never delete trajectories |
| F8 | Old workspaces | Locally and remotely, only the retained project workspaces from the old lastWorkspaceSession become same-name single-root projects with all their sessions attached; directories that exist only in historical tasks or recentProjects get no project, their tasks keep cwd and organization state and stay unclassified when no project matches; remote entries in the local lastWorkspaceSession are imported into the local remote-project entries and basic cache only on first migration, and no remote authoritative project is created locally. Remote exception (2026-10-15): when the holding owner is not local, first migration also builds same-name single-root projects from historical task roots that still have non-deleted tasks, are not under `*/.zcode/workspace/*` system directories and not marked conversation by settings, and attaches them; remote projects enter the desktop sidebar only through local entries and inference never revives a removed entry |
| F9 | Hand-made groups | Superseded by the 2026-10-13 ruling (original: migrate only hand-made groups that contain non-deleted sessions, archived members count; empty / dangling / deleted-only skipped; roots = deduplicated member directories, primary = most-populated directory; name kept and marked name_overridden; color dropped) |
| F10 | Mixed-host group | Superseded by the 2026-10-13 ruling (original: split into one project per host, host name as name suffix) |
| F11 | System groups (scheduled / off-peak) | Not turned into projects; members go to their own workspace projects and keep cron / off-peak icons |
| F12 | Auto-archive | Bootstrap's forced 7-day archive goes away with the Group view. The settings-page auto-archive (`taskAutoArchiveEnabled` / `taskAutoArchiveOlderThanDays`) must keep working: the trigger is the Host periodic scan (first run after service start, then every 5 minutes, and an immediate re-scan after either setting changes; see the 2026-09-14/15 rulings below), never a project-tree query or UI action; scope = all project roots of the current host plus bound directories of task-area sessions (deduplicated, including cwds outside the default directory; remote runs on the remote host); criterion (2026-09-15): purely time-based, `cli_updated_at` older than N days is archived; only pinned sessions and sessions the syncer observed as running are excluded, no longer completed / error / unread |
| F13 | Startup warm-up | Warm only the last active directory |

#### 2026-10-15 fix: visibility of sessions from a legacy execution backend

The project tree, the existing task list and the Controller use one execution-backend admission rule: only tasks
with `tasks.provider = ZCODE_AGENT_PROVIDER` (currently `glm`) are read. The column is the execution backend, not
the model vendor; sessions newly imported into the current CLI are kept, so filtering by `migration_source` or
title is wrong. Projects, pinned, unclassified, timeline, archive and unread views consume this Host project tree;
remote Hosts apply the same read.

Root cause: after migration backfilled `cli_*` for old rows, the project repository missed the old list's
provider filter, so legacy-backend rows were visible while the Controller's pre-operation list could not find
them. The fix only tightens reads: no row deletion, no rewrite of provider/time/organization state, no change to
published migrations/checksums; databases with an existing ledger benefit immediately. Directories that no
longer exist or tabs that are not open do not hide normal history.

```text
first migration / migrated database -> Host reads by current execution backend -> desktop / mobile share the project tree
                                    -> same admission as the old task list      -> Controller task operations
```

Acceptance supplement VP28: legacy-backend normal, pinned and archived rows are all invisible while the database
rows stay; normal CLI sessions and newly imported sessions are visible and can be unpinned/unarchived. Covers
first upgrade, existing ledger, local and remote owner; real desktop upgrade and mobile shared-host reads; a
zero-model-request fixture does not represent real legacy CLI execution.

### 3.7 Remote and related capabilities

| # | Question | Decision |
| --- | --- | --- |
| G1 | Old remote database | The remote server bundle runs the same migrations on upgrade; a new local build connecting to an old remote degrades by the old protocol to single-root project display |
| G2 | Remote single root | Creation must pick one valid directory, fixed afterwards; local still allows 0..n roots |
| G3 | Auto-connect | On startup auto-connect all saved hosts; after connecting only refresh the local added remote-project entries, never import all remote projects nor re-add locally removed ones |
| G4 | Limit | At most 20 remote hosts |
| G5 | Offline / error operations | A remote virtual project cannot expand, rename, or edit roots / primary; the only project operation is deleting the locally saved entry and cache; remote projects, roots and sessions stay, no pending-sync deletion is created. Connection-level reconnect and deleting the local host connection record stay allowed; deleting a host also removes its local project entries and never remote data |
| G6 | Re-adding a remote project | After the user actively connects and picks an existing remote project, the local entry is rebuilt with the latest info and the original project and sessions are accessed; a successful online remote create also explicitly adds an entry; ordinary reconnect or refresh never adds |
| H1 | Scheduled / off-peak / Bots | Bound to a virtual project; at creation the primary directory is cwd and the other roots are additional directories, fixed afterwards |
| H2 | Settings agent config directories | All project roots, deduplicated and flattened |
| H3 | composer # mention | Grouped by project |
| H4 | Global search | Unchanged |
| H5 | Mobile remote bridge key | Stays workspaceKey |
| I1 | Release | Separate MRs, same version release |
| I2 | E2E | Project CRUD, drag and reject, upgrade/downgrade and backup, 4.3.2 multi-directory resume, auto-archive under the project tree; task-area membership and first placement cover the 6.1 acceptance scenarios; remote offline entry management covers 6.2 |

## 4. Target architecture

G1 picks the adapter by the handshake `virtualProjects` capability, not by whether an RPC proxy exists, and never
treats a new-version read error as an old version. An old Server's project list is projected from its old
settings local directories into stable-ID single-root read-only containers; task rows still read the remote app
index; conversation-directory tasks stay unclassified. The old version supports create/resume only inside a valid
single-directory project with empty additional directories; project editing, pin, order, move and multi-root
creation are not shown and not cached locally. Normal task commands keep using the existing remote owner.

Old single-root entries use an explicit legacy-single-root ID prefix, which is only a read-adapter identifier.
After the Server upgrades, a retained entry's single root uniquely matching a real project is CAS-swapped to the
real ID on the original entry ID/version. Zero or several matches stay unresolved for explicit user selection; a
late response must not add entries. The local machine never creates remote authoritative project rows. An old
Server may not store the Controller's directory-open history, so the adapter's directory candidates also accept
roots/old cwds from locally retained entries; they are only addressing input for the old-protocol query, create
no authoritative project, and never rebuild entries from deleted old settings/history.

```text
server handshake -> virtualProjects=true  -> remote project RPC
                 -> absent/false          -> single-root read adapter
retained entry + request version -> remote read -> CAS refresh retained entry
```

(Same physical connection and logical attachment are reused.)

### 4.1 Concept model

```text
Host (machine)  local | remote:ssh:<host>:<port>:<user> | remote:wsl:<distro>[:<user>] | remote:docker:<c> | remote:server:<id>
 ├─ Project (local 0..n roots; remote exactly one fixed root)
 │    ├─ roots[]: {root_path, position, is_primary}
 │    ├─ name(+name_overridden) / position / pinned / deleted
 │    └─ sessions[] (project_id single membership)
 └─ "Tasks" area: sessions with empty project_id, any root_path

Session
 ├─ bound directory root_path (= CLI directory, never changes)  ├─ host_id  ├─ project_id? (nullable)
 ├─ Host organization state: pinned / archived / unread_at / sort_order
 └─ CLI fact mirror: cli_title / cli_title_source / cli_updated_at / cli_created_at / cli_last_outcome / cli_deleted
```

The normal section is decided by project membership; pinned, archived and session delete keep filtering by their
own rules. `~/.zcode/workspace/*` is the default execution directory of global new tasks, not a task-area filter.

```text
Session (cwd never changes)
  |
  +-- project_id -> normal project ----> project area
  +-- project_id = NULL --------------> task area (any cwd)
  +-- project_id -> deleted project --> timeline (E1, membership kept)
```

### 4.2 Processes and data flow

```text
CLI (one process per workspace, may be offline)            Host (one per window)                              Renderer
db.sqlite -- sessions-index / conversation snapshot --> taskIndexSyncer --writes cli_* mirror--> tasks-index.sqlite --> useProjectTree()
  ^                                                        ^                                       ^           (one query: projects ⨝ tasks,
  | renameSession / deleteSession / createSession          | pin / archive / read / move / project CRUD |      overlay sessions-index live fields)
  +-------- Host writes session facts via v4 commands <----+ Host writes organization state directly <--+
Forbidden: CLI writes the app database; Host writes db.sqlite; Host writes Date.now() or derived values into cli_* columns.
```

#### 4.2.1 Local remote-project entries and remote organization state

The local machine stores the "list of remote virtual projects the user added" for sidebar display; `hosts` keeps
connection targets and reconnect info. The name, roots and primary in an entry are the last successfully read
cache, used only for offline display and locating. Project content, task membership and run directory are
authoritative on the remote Host's app database; local cache must never perform remote project edits or task
resume.

```text
local hosts connection record -------------------> reconnect the given host
                                                        |
local list of added remote-project entries              v
  |                                          read the remote projects for these entries
  +-- offline: show cache, not expandable               |
  +-- delete: remove local entry + cache <---- update only entries that still exist
                                                        |
                                              never insert or restore removed entries
remote projects / roots / session membership: local offline delete does not change them
```

- The local project service exposes an explicit remove-entry operation; it does not call remote project soft
  delete, session delete or stop tasks, and writes no pending-sync queue. It is separate from online deletion of
  an authoritative project (E1); when online delete fails on a dropped connection it must not silently switch
  to local removal and report success.
- Reconnect refresh updates the cache only for entries that still exist (no unconditional upsert). An entry
  deleted after a request was sent cannot be reinserted by the late response; the `setting.json` write-back uses
  the locally committed entry list.

F5 write boundary: the Host derives `lastWorkspaceSession` / `recentProjects` / `lastActiveTabIndex` inside the
settings file lock from committed projects/roots and the local remote_project_entries. The remote full directory,
tab list and reconnect responses have no right to write the entry set. Old fields exist only for downgrade; a new
start restores only the new nullable `lastActiveWorkspace` and reads the project list directly from SQLite. That
field expresses only the last active execution directory and creates neither projects nor connection members; first
upgrade may take one selection from the old active index and never read old fields again. A remote selection must
still have a local connection member; a normal project directory must still belong to a retained project entry;
a conversation directory only needs the connection member to exist. Clearing uses an explicit null so old fields
cannot refill it.

The settings file lock covers the whole "re-read latest config -> merge patch -> derive from SQLite -> atomic
replace", not just the rename; Hosts of several windows on the same machine must not overwrite other fields from
stale snapshots. The derivation port reads only the local database and calls no settings, connection manager or
network (no recursion, no handshakes under the lock). After a project/entry mutation commits, the broadcast
waits for the compatibility derivation; if the compatibility write fails the SQLite commit stays valid, the error
is returned explicitly, and the next read/update retries the derivation. There is no remote deletion queue.

Main startup directory selection, Renderer restore and draft warm-up all use the cwd bound by
`lastActiveWorkspace`. A standalone conversation cwd no longer goes through the old "normalize to default" rule;
the default blank entry is prepared only when there is no active selection. When a project's primary directory
becomes invalid, the sidebar title is greyed but history stays expandable, new-task and view-files entries are
disabled, state is derived live by the owning Host and the edit entry stays; see
[Project primary root availability](../../project-primary-root-availability.md).

```text
project / retained-entry mutation -> SQLite commit -> settings file lock
                                                      ├─ latest settings + latest catalog
                                                      └─ legacy projection -> atomic replace -> broadcast
renderer activation -> lastActiveWorkspace ───────────┘
```

- The remote full project list serves only user-initiated adding; a new remote project or unchanged name/roots
  never justify automatically adding a local entry. Deleting an entry deletes neither the host nor other entries
  of that host; deleting the last entry does not stop the user from reconnecting and adding manually.
- Removing a local entry triggers no E1/E1a remote soft delete or restore. Re-adding the same remote project later
  uses the original project ID and reads existing content and sessions.

All saved physical connections may enter the existing reconnect batch at startup, with no eviction by last-online
time; `remoteStartupAutoReconnectEnabled=false` and the silent-credential requirement are still honored, and no
Agent is created for project expansion. The separate gate for restoring logical tabs from workspace history does
not change this eligibility.

Connection membership and connection runtime state are separate: local remote-projects is the sole writer of
which physical Hosts/project entries are saved; the existing Source Directory owns Profile routing and credential
references; ConnectionManager owns connection instances/retries. A new or explicitly re-added connection gets an
immutable `hosts.membership_id`; a handshake may merge an old-address Host into a stable Source Host only with
the membership ID it started with. Remove then re-add produces a new membership ID, and an old handshake can
neither revive nor rebind the new entry. Merge and entry host_id adjustment run in one app-database transaction;
no remote authoritative project is moved and no task index copied. A known stable Source changing identity still
goes through the existing explicit confirmation and never migrates old-Source project entries to another machine.

```text
explicit save -> Host membership ID -> existing ConnectionManager connect/handshake
                                    -> compare membership ID -> merge into stable Source ID
remove connection -> delete membership + local entries
late handshake -> membership mismatch -> discarded, cannot INSERT
```

ConnectionManager obtains the member instance through an injected port before probe and commits the binding after
handshake confirmation and before publishing online; on rejection it releases this connection. An explicit user
connect may add a member; startup and fault auto-reconnect may only keep existing members and cannot re-save.
When the user confirms a Source identity change, a separate new Source connection record is added while the old
member is still valid; the old Source and its entries stay in place and the new Source counts capacity on its
own. That condition check and the write happen in one transaction.

The local entry service's connectHost is a narrow reconnect entry over the existing connector, only for retained
members; its assembly port uses retain admission and saves no new members or entries. Connection status is read
from ConnectionManager and attached to the readDirectory result, never stored in SQLite and without a new state
machine. Where the scope's current service does not support connection management it rejects explicitly.

URL Server physical connections stay solely owned by WindowRemoteConnectionRegistry. Project queries/startup
reconnects go through the Registry's Host connection entry without creating a logical session or Agent; a
workspace attachment is created only when an execution directory is opened and reuses the same physical
connection. The Registry offers read-only enumeration of current connections and stable-Source lookup, with no new
connection-state store. SSH/WSL/Docker physical connections stay with the original SourceManager. A URL Host
membership is saved/obtained before the handshake, the token goes only to CredentialService, and `hosts` stores
only the credential key. Auto-reconnect reads only existing members and credentials; removed/re-added old
handshakes must be invalidated. An address identity for an unknown URL serverId may be bound to a stable Source
after the first handshake, which also fixes `target.serverId`; a changed existing serverId is an explicit error
and never moves old projects. Connection failure releases the unpublished socket; concurrent requests for the same
URL/stable Source reuse the Registry owner. Removing a member does not terminate existing tasks but forbids new
directory/project connections and auto-reconnect.

```text
saved URL member -> credential lookup -> Registry physical connection -> membership CAS
                                                    ├─ project read (no logical session)
                                                    └─ workspace attachment -> existing task owner
```

The remote connection list enumerates only local hosts records with a usable connection target; the
`target_json=NULL` identity placeholders needed by historical task shadows are not user-saved connections, are not
shown and do not use the 20-host quota. Cache refresh always advances the compare-and-swap version and, when
content is unchanged, emits no project-change broadcast (no read -> refresh -> broadcast -> read loop).

Migrated old workspace entries resolve a project ID only when exactly one project on the same Host contains the old
cwd; zero or several matches stay pending selection. Several old cwds resolving to one project keep the resolved
entry's ID and drop duplicates in the same transaction as the CAS refresh. The sidebar aggregates only remote
projects and tasks of locally retained entries; unclassified tasks under a saved Host go to the task area and
history of soft-deleted projects still goes to the timeline. Offline shows and caches no remote task index.

For a Web/client attached directly to the remote owner, projectService returns that owner's authoritative tree,
the remote-projects entry query returns an empty directory, a Controller member table is never faked, and entry
write commands are rejected. A desktop window's Controller queries still use the local base attachment,
separate from the workspace-scoped remote service.

### 4.3 Interface with the CLI (B14 increment)

Additional directories are the project folders other than the session's default working directory, used together
with the task. E.g. a project with frontend and backend directories: a task bound to the frontend has the backend as
additional directory. New tasks and history tasks opened after a restart must fully load the capabilities those
directories provide.

```text
createSession / explicit resume / v4/conversation/subscribe gain an optional parameter
  additionalDirectories: string[]        // Host-resolved list; local absolute paths or actual remote paths
                                         // consumed only when the runtime instance is initialized; live subscribe does not update scope
CLI consumers
  1. skillPort.discoverSkills/loadSkill(roots?)  -> per extra dir add <dir>/.zcode/skills, <dir>/.agents/skills, <dir>/.zcode/commands
                                                    skills from an extra dir: qualifiedName = `${basename(dir)}/${name}`; prompt and mention list use qualifiedName
  2. subagents roots                             -> add <dir>/.zcode/agents; same names coexist, same qualifiedName
  3. tool path policy                            -> additionalDirectories join the readable/writable roots
  4. environment prompt                          -> after the primary directory list Additional directories, paths only; an empty list prints nothing
Unchanged: AGENTS.md, config (settings/mcp/hooks/plugins), memory, permissions still resolve only by workingDirectory.
```

The environment prompt uses the `additionalDirectories` received when the run instance was initialized, keeps paths
one by one, does not scan directory contents and adds no permission text. The list only flows via Runtime config
to ContextBuilder, is not written to an environment snapshot and adds no persisted field; directory changes take
effect on instance rebuild per 4.3.1.

#### 4.3.1 Directory source and effect timing

Create order: the UI passes only the selected `projectId` (explicit NULL for global create). The Host allocates a
stable session ID from the create command's idempotency ID, reserves membership and reads directories in one app
transaction, and only then sends create/firstInput to the CLI. The reserved row has an empty `cli_created_at`
and is hidden from all lists until the CLI publishes persistent session facts. The placeholder signature is
`cli_created_at IS NULL AND created_at = 0 AND meta_json = '{}'`: such rows do not enter `listTaskMetas`,
`queryTaskList` or `hasTaskMetas`, produce no "invalid meta_json" warning on read and are not deleted; they become
visible only after `applyCliFacts` writes CLI facts. Other writers' `created_at = 0` rows carry a `meta_json`
other than `'{}'` and are unaffected. A repeated create never overwrites membership that was already moved;
failure fakes no session facts. The CLI does not receive a project ID, only the session ID and
`additionalDirectories`, and rejects overwriting an existing runtime instance or persisted session; command retries
are still deduplicated by CommandInbox.

Abandoned reservation lifecycle: a draft prewarm session may be discarded before the first send, and an ordinary
create may be rejected by the CLI with a rejected ACK (e.g. `project.not-found`). The project repository writes the
reservation and the same owner deletes it: when the deleteSession ACK is accepted or noop, or rejected with
reasonCode `proto.sessionNotFound` (the CLI never initialized the session, i.e. an abandoned draft), or an
ordinary createSession (without submissionPreparation, expectedSubmissionId, preparedSessionId,
worktreePreparation) gets a rejected ACK, only a row that still matches the placeholder signature (no CLI facts)
is deleted; a missing row is a no-op. Durable first-send reservations and worktree reservations are kept for an
explicit Retry and are not deleted on failure. Unknown call results (thrown, duplicate, stale) keep the row
because the CLI may have created the session. Placeholder rows left by an app crash or exit have no cleaner: the
signature has no time, so abandonment age cannot be judged, hence no unbounded startup sweep. Open follow-up
needing separate design.

Fork-session membership (2026-10-22): a forked child session is created by the CLI, which knows no project, so the
Host does not reserve via the create path. On the accepted ACK of `forkAssistant` returning the child session ID,
the Host claims the child through its parent: `reserveCreatedTask({ task: child, forkOf: parent })`, in the same
transaction and by the same writer (project repository) as create. The child inherits once the parent's
`project_id`, `host_id`, cwd (`root_path`) and the parent's resolved additional directories, frozen as the child's
`execution_directories` snapshot (I2, I16); later changes to project roots do not change the fork child's
directories, same as ordinary create. A fork child becomes visible after its first CLI sessions-index summary: the
Host first claims it (when the child row still has `host_id IS NULL` and the parent row belongs to this Host; same
transactional writer as the ACK path, no repeat write if already claimed), then applies CLI facts (I14, I17).
Facts may only be applied after the claim, otherwise `admitTaskIdentity` would place by cwd first and break the
inherited parent project and frozen directories. Unattached fork rows (`host_id IS NULL`) existing before the
upgrade are claimed the same way when their first summary or first baseline snapshot arrives and the parent row is
attached; if the parent is unattached they keep the ordinary unclassified admission and fork claiming does not
attach them.

- The claim does not reuse `projectId` create validation (a soft-deleted project or a cwd outside current roots is
  still allowed) because the parent's membership is already in effect; a fork is not a new project membership.
- Parent row missing -> `project.fork-parent-missing`; parent `host_id` not of this Host -> `project.host-mismatch`;
  parent and child workspace keys differ -> `project.fork-workspace-mismatch`. All three reject directly, never
  fall back to `[]` or guess a project by path; the `project.host-mismatch` check is not relaxed.
- A child row that already has `host_id` is not claimed again, so replaying the same ACK is idempotent. The child
  row may arrive before the ACK (an unattached row written by the syncer) or after; either order is fixed by the
  claim, which never writes CLI fact fields (`cli_*`).
- The claim covers only the child returned in the ACK. Other CLI fork entry points not wired through
  `forkAssistant` still reject the first send with `host-mismatch`; relaxing validation to hide it is forbidden.
- Existing historical fork rows (`host_id` empty, older than this rule) are not backfilled and need a separate
  migration decision. A child row's CLI fact (`cli_created_at`) is written by the syncer's `applyCliFacts`; until
  then the child is not in the sidebar list. This visibility gap needs separate design.

```text
Host sends forkAssistant (parent session ID)
        |
CLI copies history and creates the child (child ID, directory = parent's directory)
        |                                   \
        |                  syncer writes the child index row (may be unattached, host_id NULL)
        v                                   /
Host receives accepted ACK (result.sessionId = child ID)
        |
reserveCreatedTask({ task: child, forkOf: parent })   [single transaction, idempotent]
        |  parent host mismatch / missing -> reject
        |  child already has host_id -> do not overwrite
        v
child row: host_id = this Host, project_id = parent project, root_path = parent cwd, execution_directories = parent's resolved extra dirs
        |
child first send -> resolveSessionDirectories(child) returns the above membership
```

```text
select project -> Host reserves session membership + reads roots (transaction)
                         |
         CLI CommandInbox dedupe -> create runtime -> first input -> durable facts
                         |
                  visible in lists after Host mirrors
```

Project membership and roots persist only in the Host app database. The Host project service provides one
directory-resolution routine reused by create, explicit resume and V4 cold resume; the CLI only receives a
directory list, reads no app database, knows no project_id, and gets no persisted roots copy for ordinary tasks nor
a directory-sync protocol. A new-version Host passes the array explicitly after successful resolution (including
`[]`); the field is optional only for old callers and omission must not mask a query failure.

- New ordinary task: the Host uses the project selected and validated for this create. Resuming an ordinary task:
  query its explicit project_id by `workspaceKey + taskId` and then read the project's current roots. Never guess
  the project from cwd, since one real directory may belong to several projects. Task membership and roots in one
  read come from the same database read snapshot.
- `additionalDirectories = project's current roots, deduplicated, excluding the session's fixed cwd`. What is
  excluded is the session-bound directory, not the project's current primary; changing the primary or removing the
  original cwd from the project never changes a historical task's cwd. Path normalization and deduplication reuse
  the owning Host's platform path rules.
- Unclassified tasks explicitly use `[]`; a soft-deleted project still keeps membership and roots and history
  tasks resume with them. Three absences are distinct: no task row in the app database (TUI-created, sessions-index
  arrived before seeding) is unclassified and passes `[]`; a row exists but `project_id` points to a nonexistent
  project -> explicit error; app database read failure -> explicit error. Errors must bubble to the UI (message +
  retry); they must not start an incomplete runtime instance as `[]` nor fail silently.
- Scheduled tasks, off-peak tasks and Bots follow H1: the Host supplies cwd and additional directories from the
  configuration frozen at creation, also on resume, never re-reading the project's current roots. The reservation
  that creates the new session writes the immutable snapshot `tasks.execution_directories` (nullable TEXT JSON) in
  the same transaction; ordinary sessions have NULL and still resolve from project current roots. The snapshot
  belongs to the generated session's initial configuration; the Host create reservation is its only writer;
  deleting a schedule/Bot definition or retrying a reservation must not clear/overwrite it; the three resume
  entries for manually opened history tasks read it too. It is not a synced copy of ordinary project roots.
  Session-bound definitions keep reusing the existing session; a working session never becomes permanently
  frozen to directories.
- The CLI uses the passed list only when creating or truly rebuilding a runtime instance, as fixed initialization
  parameters for that run. When an instance exists, plain subscribe, resubscribe, mobile reconnect and the reuse
  path of explicit resume do not refresh directories; project edits and task moves take effect on the next
  rebuild. Concurrent subscriptions resuming the same session reuse the existing Gateway READY / cold-resume
  single-flight; one determined directory list is adopted for that resume and later subscriptions neither merge
  nor override it.
- Remote tasks are resolved by the remote Host that owns the project organization data and pass the actual remote
  path; workspaceIdentity, remoteSessionId and trusted clientMode keep flowing along the existing attachment
  chain. Desktop stays desktop-continuous, mobile stays web-remote-replayable, and they share the original
  runtime instance.

```text
Host app database: task membership + project current roots (the only configuration source)
                         |
                Host resolves the directory list uniformly
                         |
          +--------------+-------------------+
          |              |                   |
       create        explicit resume     V4 subscribe
          |              |                   |
          +--------------+-------------------+
                         |
               does the CLI already have a runtime instance?
                 /                 \
               no                   yes
               |                    |
      initialize once with list   reuse existing instance and directory scope
               |
       scope fixed for this run
```

Landing points: the Host's `subscribeConversationV4` calls the same directory-resolution routine before sending
its request; reuse the `resumeThoughtLevel` parameter path but never swallow directory query errors. Update the
create/resume schema in `packages/shared/src/zcode-protocol/index.ts` and the subscribe schema in
`packages/shared/src/zcode-protocol-v4/transport.ts`; thread `additionalDirectories` through Gateway ->
`ColdSessionResumeCoordinator` -> `resumePersistedSession` -> `activateSessionForResume` and hand it to the
capability and environment-prompt consumers before the instance is built. The Host injects resolution through a
service interface; the Renderer does not assemble directory lists.

Implementation supplement (2026-09-10): current rowsRange / search queries may also trigger cold resume before
subscribe. That path reuses the existing `session/requestRuntimePreferences` runtime-materialization request and
gets `additionalDirectories` from the same Host resolver; no second directory cache or sync protocol. Explicit
create/resume/subscribe arrays are used only when a new instance initializes; a Host query failure must reject
initialization. The reverse request is already covered by READY single-flight, so a query racing a subscription
reads the directory snapshot once.

#### 4.3.2 Local multi-directory resume acceptance

Remote projects are single-directory; rows involving additional directories / changing roots apply to local only.
Remote create and cold resume require empty additional directories, and changing project directories must not be
used to verify remote resume.

| Scenario | Expected |
| --- | --- |
| Project primary A, additional B; create a task, restart the CLI, open the history task only via V4 subscribe | cwd stays A; skills, subagents and tool directory scope of B match explicit resume; not just the list display is verified |
| While running, change the project's additional B to C, then switch page or reconnect mobile | the current instance still uses B; C applies only after the instance is rebuilt |
| Change the project's primary from A to B, then cold-resume a history task bound to A | cwd stays A, B is an additional directory; B is not excluded by the new primary |
| Two projects both contain A, adding B and C respectively; both tasks have cwd A | each takes directories by its explicit project_id; sessions in the same CLI process do not share direction scope |
| Desktop and mobile subscribe to the same cold session concurrently | one runtime instance is initialized, both subscriptions share this directory scope and keep their own delivery profile |
| Unclassified task, history task of a soft-deleted project, project query failure | respectively empty additional directories, the retained project's roots, an explicit error; the three must not merge into an empty-directory fallback |
| Resume an existing scheduled task, off-peak task or Bot after editing project roots | keeps using the cwd and additional directories frozen when the capability was created |

Protocol and CLI unit tests cover parameter threading, directory consumption and concurrent resume; Host unit tests
cover membership resolution, path dedupe and failure branches. E2E covers desktop and mobile, local and remote
create and cold-resume entries and verifies that additional directories do not change the AGENTS.md / settings /
MCP / hooks binding rules. All remote projects are single root; old-remote capability degradation follows G1 and
shows no multi-directory operations. All of the above are acceptance items still to run in the implementation
phase.

## 5. Data model

### 5.1 App database `tasks-index.sqlite` (additive only, V1)

```sql
CREATE TABLE IF NOT EXISTS schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS hosts (
  host_id TEXT PRIMARY KEY,            -- 'local' | remote authority (identity without the path part)
  kind TEXT NOT NULL,                  -- local|ssh|wsl|docker|server
  target_json TEXT,                    -- RemoteTargetSnapshot (credentials stay in credentials.json)
  position INTEGER NOT NULL DEFAULT 0, last_connection_status TEXT, last_connection_error TEXT, last_opened_at INTEGER);
CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(host_id),
  name TEXT NOT NULL, name_overridden INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, pinned_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS project_roots (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  root_path TEXT NOT NULL, position INTEGER NOT NULL, is_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, root_path));
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_host_name ON projects(host_id, name) WHERE deleted = 0;
-- tasks: appended with ensureColumn, all nullable
ALTER TABLE tasks ADD COLUMN host_id TEXT;            -- derived from workspace_key, NULL = written by an older version
ALTER TABLE tasks ADD COLUMN root_path TEXT;          -- = workspace_path
ALTER TABLE tasks ADD COLUMN project_id TEXT;         -- nullable; soft-deleted projects keep it
ALTER TABLE tasks ADD COLUMN sort_order INTEGER;      -- reserved (no manual ordering in this phase)
ALTER TABLE tasks ADD COLUMN cli_title TEXT;          -- mirror column; old columns title/title_overridden/updated_at/task_status keep old semantics
ALTER TABLE tasks ADD COLUMN handoff_pending INTEGER NOT NULL DEFAULT 0;  -- bit flags: 1=delete intent pending handoff 2=manual title pending handoff 4=CLI has no such session (orphan) 8=empty-membership placement already judged
ALTER TABLE tasks ADD COLUMN cli_title_source TEXT;
ALTER TABLE tasks ADD COLUMN cli_created_at INTEGER;
ALTER TABLE tasks ADD COLUMN cli_updated_at INTEGER;
ALTER TABLE tasks ADD COLUMN cli_last_outcome TEXT;
ALTER TABLE tasks ADD COLUMN cli_deleted INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_host_task ON tasks(host_id, task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, archived, cli_updated_at DESC) WHERE deleted = 0;
```

Mirror columns vs old columns: Host organization state (`pinned/archived/unread/title_overridden/deleted` intent)
has **only the original columns**, no copy. CLI facts: code reads only `cli_*`; old columns `title` (when not
overridden), `updated_at`, `task_status` are read only by pre-V1 versions and dual-written by the syncer. Display:
title = `title_overridden ? title : cli_title`; hidden = `deleted OR cli_deleted`; order = `cli_updated_at`.
automations / off_peak_tasks gain nullable `project_id`, `host_id`.

Runtime deletes accept the generic persistence entry of a whole `TaskMeta`. Restore snapshots update only model,
target, error details and searchable text; title, time, existence and result must first be ingested through CLI
reconcile. Drafts without durable facts return only temporary display values and are not inserted into lists.
Claude import must first create a real CLI session and ingest through the same fact entry; backup JSON does not
write the index or revive deleted sessions. Explicit re-import creates a new CLI session ID and does not overwrite
existing/deleted sessions by external-source hash; old deterministic IDs are only used to read and repair existing
backups. A regression test deliberately pollutes old fact columns and `meta_json` and verifies that all list
ordering, search and display still read only the mirror.

Legacy `session/create` and V4 create share the membership reservation: the Host generates the session ID before
the wire request and atomically saves project_id (NULL when unspecified); the CLI accepts a not-yet-existing
assigned ID and uniformly rejects overwriting the same ID in memory, persisted or being created. Only a short-lived
ID hold exists during creation, released on failure; it accepts no user input and is not a second command queue.
V4 idempotent results are still stored by CommandInbox. Additional directories of legacy native create are
resolved by the Host membership; frozen configs such as scheduled/off-peak travel as explicit parameters.

### 5.2 CLI database `db.sqlite` (new migration 0020)

`0019_dwf_journal` was taken by a historical version, so this change uses `0020_session_soft_delete_outcome` and
leaves historical SQL and checksums alone. (After the 2026-09-14 upstream merge this migration is renumbered
`0023_session_soft_delete_outcome`; see [Session Manage upstream merge](2026-09-14-session-manage-upstream-merge.md).)

```sql
ALTER TABLE session ADD COLUMN time_deleted INTEGER;   -- soft delete
ALTER TABLE session ADD COLUMN last_outcome TEXT;      -- completed|error|interrupted, written at turn end
-- time_archived stays as a column, marked @deprecated in code, no longer read or written
```

`listSessions` / the sessions-index cold seed add a `time_deleted is null` filter; `SessionSummary` gains an
optional `lastOutcome`, and the cold-seed phase derives from `last_outcome` (NULL falls back to completedSuccess).
V4 `deleteSession` now writes `time_deleted`, calls closeSession and emits `session.removed`.

New request command `sessionsIndex/reconcile { workspaceId, sessionIds[] }` -> per id returns
`{ exists, deleted, title, titleSource, updatedAt, lastOutcome }` (soft-deleted rows included). Used by the Host,
after a subscription snapshot, to reconcile rows that are "locally not marked deleted but absent from the
snapshot", and for read-back verification after handoff. Absence from a snapshot alone never makes the app delete a
row.

### 5.3 Local remote-project entries and cache

Entries and their basic cache are stored separately in the local app database so they are not a second editable
copy of remote `projects` / `project_roots`. Connection parameters stay in `hosts.target_json`; credentials use the
existing credential store.

```sql
CREATE TABLE IF NOT EXISTS remote_project_entries (
  entry_id TEXT PRIMARY KEY,              -- local entry identity, offline removal locates by it
  host_id TEXT NOT NULL REFERENCES hosts(host_id) ON DELETE CASCADE,
  remote_project_id TEXT,                 -- remote project ID; nullable while an old workspace is unresolved
  cached_name TEXT NOT NULL,
  cached_roots_json TEXT NOT NULL DEFAULT '[]', -- last read roots / order / primary
  legacy_workspace_json TEXT,             -- original workspace path and identity kept by first migration
  last_synced_at INTEGER,
  UNIQUE (host_id, remote_project_id));
```

Old remote workspaces from first migration can be saved as entries with their original identifiers before
connecting; after connecting only entries that still exist resolve the remote project ID and update the cache, and
old remotes keep G1 single-root display. Entries come only from first migration, explicit user adding or a
successful online project creation; ordinary refresh has no permission to create entries. Deleting an entry
deletes the row and its cache and restart never rebuilds it from old setting.json or the remote list. The table
stores no remote session index, task content or pending remote-delete intent.

The project service routes by explicit `hostId` on the base attachment. A request for the current Host goes to its
own repository; other Hosts only get an online project-service proxy from the existing connection manager and
fail directly when offline, never persisting locally. After reading a remote tree it registers a canonical/stable
mapping via existing Source workspace identity resolution. Mobile reuses the same base attachment routing, applies
for no forbidden source-settings attachment and creates no new runtime.

Workspace attachments also forward to the remote project service while entry directories are always read from the
Controller base attachment. The new service is not added to the old v1 required channel set (old Servers must
still connect); the handshake declares the new capability by optional `capabilities.virtualProjects`, absence means
old single-root, and remote support must not be inferred from a client-generated proxy object. A remote global
create allocates an independent cwd each time, and a logical session already bound to any workspace must not rebind
to the new cwd; the same physical connection is reused with a new logical attachment.

The project tree includes remote tasks of tabs not opened. Its list commands reuse the Window Controller's
mutateTask routing: locate the existing online physical connection by stable Source + workspaceIdentity, read the
owner's task row first to verify the address, then run the same task service; rename is also handed to the original
CLI command. Queries and pin/archive/read create no logical workspace, switch no tab and start no Agent. A
workspace attachment is built/reused only when a session is opened; mobile still uses the shared-host replayable
switcher; no remoteSessionId may be faked for list commands of unopened tabs. Offline or identity mismatch is
rejected directly, never falling back to local.

Local entry management is consolidated in the `remote-projects` service contract:
`readDirectory / saveHost / removeHost / addEntry / refreshEntry / removeEntry`. The project service handles only
authoritative projects of the holding Host; the entry service accepts no task index or remote write operations. A
new entry produces a new entry ID; a cache refresh must carry the entry ID and lastSyncedAt at request time and the
SQL only UPDATEs with compare-and-swap. After an entry is deleted a late response has no write target; re-adding
the same project ID after removal produces a new entry ID and the old response still cannot overwrite it. Host
deletion and its entries' deletion share one SQLite transaction, and the 20-remote-host limit is checked inside the
write transaction. Connection runtime state stays with the connection manager and credentials with the credential
service, never in target JSON.

```text
explicit add -> local entry row (new entry ID) -> start remote read
                                     │
remove entry ────────────────── DELETE
                                     v
late read -> UPDATE WHERE entry_id AND last_synced_at -> 0 rows, no rebuild
```

Connection admission re-checks cancellation and the current owner after every await: online-connection reuse must
not return a stale disconnected object after waiting for a member commit. A newly created transport is exclusively
owned by the current connect call until online is published; if directory recording, identity confirmation or
member commit fails, all release the unpublished connection through the same cleanup path. Closing an unpublished
connection must not trigger recovery of another already-online connection; one closed before publication is
rejected.

Automation and off-peak definitions freeze `project_id / host_id / additional_directories` at creation commit. A
form selecting a project submits only the project ID, and the Host resolves cwd and additional directories through
the project service; an invalid or deleted project must fail before taking a number or storing a definition.
Scheduled dispatch, retry and off-peak resume read the saved configuration and never re-evaluate the project's
current roots; later roots edits do not alter these definitions. Session-bound tasks keep their existing semantics
and do not become new sessions through the directory option refactor; a bound task and a newly selected project
must not be submitted together. Dispatch carries the Host-saved additional directories (including an explicit empty
array); the membership reservation only checks the project still exists on the same Host and no longer rejects an
existing definition by current roots or the soft-delete flag; ordinary new creation still validates current roots
and non-deleted projects. The CLI only receives directories, never the project ID.

## 6. UI behavior notes

### Selecting the draft project after creation (2026-10-16)

The sidebar "New project" and the draft top-left project menu share completion behavior: after the project is
saved (remote: local entry also registered) and the directory refreshed, if the originating chat is still the same
draft, the new project is selected automatically. It uses Root/Host project navigation and keeps the draft's body,
rich-text mentions, attachments and group intent; it sends no message. Ordinary manual project selection still
restores drafts per workspace. Existing sessions, creation failure, cancel, adding an existing project and editing a
project do not trigger it.

```text
ProjectEditor save -> ProjectCreation registers and refreshes -> verify original tab / workspace / draft generation
                                             ├─ same draft -> read editor snapshot -> Root prepares new project -> restore body and attachments
                                             └─ switched or sent -> keep only the creation result
```

Projects and directories stay with the Host; organization intent with the session store, body with the composer
draft owner, attachments with the existing upload owner. The snapshot is only a one-shot hand-off command in
renderer memory; the body writes to the target draft, attachments are re-prepared at the target from original
File/path (old session upload refs are not reused, no new attachment persistence). Mobile Root rebuild uses the
same hand-off command; attachment hand-off may be consumed only once by the same generation of the target draft. On
preparation failure the source draft is unchanged. A late result after save/refresh must not switch the current
workspace if the user switched workspace, selected a session or rebuilt the draft. Acceptance PCD01-03 cover local/remote
completion, both entries, draft invalidation and failure isolation.

Implementation cleanup: the new project tree replaces the old WorkspaceSidebarItem, SortableWorkspaceSidebar, old
Timeline/Pinned/Archived sections and useWorkspaceTaskLists; deletion happens after a reference audit confirms no
production caller, with no parallel task-list aggregation and no workspace/group sort state. Shared task-row
rendering, workbench drag, search and Header keep using the original public capabilities. Per-row reference
stabilization keeps reusing `taskListItemStabilization`: an equal snapshot does not rebuild the tree, only real
membership or activity changes update rows; identities are Host + project ID and workspaceKey + task ID. The old
workspace store's draftSessionId / setDraftSessionId have no production writers and are removed with the old
session-management path. Prewarm sessions are owned only by the V4 pane; project, skill or plugin changes notify
the pane to recycle and rebuild via a workspaceIdentity-isolated invalidation version. Config UI does not close
draft sessions directly nor copy runtime IDs to a global store; the side panel attributes by the formal
activeTaskId only and drafts follow the existing empty-membership semantics.

- Sidebar: top global pinned area (sessions + pinned projects) -> "Projects" area (title context menu: sort by
  time / by project) -> "Tasks" area. The timeline implementation stays, its switch entry is hidden (replaced by
  the 2026-09-15 view switch below).
- New-project wizard: type (local / remote) -> remote picks a connection first -> multi-select folders (optional)
  -> name (default first root name / "新项目") -> primary directory (default the first).
- Edit dialog: name, add/remove roots, set primary (deleting the primary auto-promotes the first). The project
  action menu uses non-modal navigation; only the edit dialog owns modal pointer/focus restriction. Opening and
  quickly saving the dialog while the menu exit animation is unfinished must still restore page interaction,
  without manual body style changes or timeout-based unlocking.
- Drag: session -> other project (same host only; for local targets missing the root a dialog "add the folder to
  the project" appears; remote target directory mismatches are rejected directly); task-area session -> project
  (same, using that session's real bound directory, cwd outside the default directory allowed); project node
  reorder.
- Delete project: local projects and online authoritative remote projects follow E1 soft delete; the timeline
  still shows their sessions; creating a project whose roots set equals (same host) a deleted project pops up
  "Found deleted project P (N sessions), restore?" and restore is undelete; no other restore entry and no hard
  delete.
- Remote project node: when offline or connection failed it shows the cache and offline / error state, cannot
  expand, rename, or edit roots / primary; the only project operation is "delete", meaning removing the local
  entry and cache while remote projects and sessions stay. Connection-level reconnect or deleting the local host
  stays available; reconnect does not restore removed project entries.
- composer: @file across roots with a root suffix; skills / subagents use qualifiedName; # mentions grouped by
  project.
- Settings agent config management: directory dropdown = all roots deduplicated and flattened; hooks trust by real
  directory.
- Scheduled / off-peak / Bots: pick a project; at creation freeze cwd = primary directory and additional
  directories = other roots. Form candidates come from the project service, independent of open directory tabs;
  several projects with the same cwd are selected independently by project ID. A project with empty roots can be
  selected directly and the Host creates the default directory only at submit; model-list preview uses that Host's
  model service. Editing an existing definition keeps its original cwd/directory snapshot.

#### 6.0.1 Bot project binding and old-state hand-off

A Bot's multi-project authorization keeps the existing `allowedWorkspaces` field and the `/workspace` command, but
a candidate ID now means Host + project, no longer cwd. Candidates share the project directory read contract: the
current owner's projects plus online remote projects of locally retained entries; no projects are made from
tab/history and no Agent is started to enumerate. Several projects with the same cwd are listed separately;
ambiguous directory/name input requires choosing an explicit project.

The Bot context is the only durable source of the Bot's execution binding. On first context creation (including
the first persisted provider offset) or when the user explicitly switches project, call that Host's
`prepareSession` and save projectId, hostId, cwd, workspaceIdentity and additionalDirectories. After that `/new`,
status reads, model preview and restarts keep this snapshot and never rewrite cwd from the latest roots. A newly
generated task passes the snapshot to the existing task-creation reservation; resuming an existing task keeps
following that task's own Host reservation.

The Bot Repo reads and updates a single context under one file lock; commands, provider cursor and deletion all go
through this entry, and overwriting other Bots with a whole stale state read by the service layer is forbidden.
First binding uses the Repo's current context as the CAS basis; command updates preserve independent writers'
Telegram/WeChat cursors. The file address is fixed when the Repo instance is created and async operations do not
reinterpret environment paths. A history context is handed off only once when hostId is missing: keep the original
cwd, fill identity/project membership that can be uniquely confirmed, additionalDirectories `[]`. Several
same-cwd projects are not guessed and store an explicit NULL; a processed NULL is not attached later by newly
added projects. Old path authorizations convert to project IDs only when the candidate is unique; ambiguity does not
widen permission. A late click on a selection menu must re-verify the current authorization, entry membership and
project existence and must not execute the stale menu object.

`/task` candidates come from the owning Host project tree and include only tasks with the current fixed
cwd/identity and an explicit projectId; other projects with the same cwd cannot mix in and no task ID or old menu
bypasses this check. Switching an existing task changes only activeTaskId and never overwrites the Bot's project
selection ID or execution-directory snapshot.

```text
project/entry owner -> read candidates (verify member and entry before and after)
explicit choice -> prepareSession -> Bot Repo freezes execution binding -> existing task-creation reservation
roots edit ─────────────────╳ does not change the Bot context
desktop continuous / mobile replayable -> original owner, CommandInbox and resume chain
```

- Auto-archive: the settings toggle and days stay; the scanner filters purely by the CLI last-activity time mirror
  inside one write transaction and changes only `archived`; it excludes only pinned sessions and sessions the
  syncer observed as non-terminal (since 2026-09-15 result and unread no longer matter), never starts the CLI for
  the query and never persists live phase. The trigger is the Host periodic scanner (first run at start + every 5
  minutes + settings-change re-scan); project-tree queries and clicking a task no longer trigger it. Scope = all
  project roots plus bound directories of task-area sessions; an archived row enters the timeline's archived
  state and keeps its project membership.

#### 6.0.2 Host dependency injection for Bot remote execution

Bot remote execution directly uses the SourceServerConnectionManager / URL Registry services already online in the
window Host. It no longer queries workspace sessions through main, creates a Bot logical session, or hands off a
second runtime MessagePort. `/reconnect` only calls connectHost of a retained host; a request after member removal
fails and never revives a connection from old settings. A Server's own Bots use their owning Host's local
services.

An old Bot canonical identity resolves the holding host through a retained entry's legacyWorkspace and saves
hostId only on first hand-off; later routing uses the saved hostId, and removing the entry does not rewrite the
bound cwd/identity. A stable server identity inconsistent with an explicit hostId is rejected. Before and after
project binding both host membershipId and entry ID are checked, and remove-then-add cannot accept an old
prepareSession result.

Remote directory admission reuses the Source workspace alias; while waiting it validates against the physical
connection object and membershipId, rejecting late results. Config candidates, project membership and CLI content
are still decided by their existing owners; the router keeps no copy of projects, TaskMeta or connection state.
Bot dynamic events stay `bot-channel-continuous`: a connection generation change only replaces the live
subscription without splicing mobile snapshot/replay; commands follow the original task service / owner lease /
CommandInbox. The Bot router may hold subscription handles for its own consumers, source-connection notifications
drive resubscribe, and late events are dropped after close; no timer polls connections and no second accepted-input
queue is created. App runtime preferences read from existing settings; only online targets with persisted Bot
bindings take part in active sync.

```text
Bot context fixed address -> Host router -> existing Source/URL services -> same CLI owner
explicit /reconnect       -> retained host connectHost
Source connection generation change -> replace Bot live subscription (no replay)
desktop continuous / mobile replayable -> each original attachment, unaffected by Bot route replacement
```

<a id="603-手机项目新目录的-shared-host-admission"></a>

#### 6.0.3 Shared-host admission for mobile project new directories

Mobile home and the desktop sidebar mount the same ProjectSidebar and read the row set from the project contract of
the same base attachment; mobile-specific workspace grouping, title/status derivation and duplicate list caches are
removed. The mobile shell only owns home/chat, browser back and the sidebar overlay, and holds no project/task
copies. ProjectSidebar open events enter chat after succeeding through the original replayable switcher; new drafts
go through the Host admission below. View/sort share the project sidebar controls and no longer read the retired
mobile workspace-grouping preference.

For home-only (the initial target workspace cannot build a bridge, Root has no projectService) there is no base
attachment and thus no project contract. ProjectSidebar's project/task areas then show the desktop window
workspace list returned by the relay-layer `listWorkspaces`, shared by phone and wide screen; project-tree read
failures are not shown here. List facts come only from the desktop: requested once on mount, afterwards only
`workspace-list-updated` pushes are taken, no polling; if a push or a new request arrives after a request was
sent, the late old response is discarded. Each row shows the workspace name and connection state:

- Can build a bridge (local, or remote with workspaceIdentity + remoteSessionId): click opens that workspace's
  bridge Root via `switchWorkspace`, landing on the home page without entering chat.
- Cannot build a bridge: shows "未连接 · 连接" (not connected · connect; with `lastConnectionError`, a connection
  failure label); click hands off to the desktop's existing reconnect owner via `reconnectWorkspace`; on success
  the list is requested again, the row becomes openable and nothing is switched automatically.
- Desktop reports `reconnecting` or this page's request is in flight: the row is disabled and shows connecting.
  Request failure shows a toast and the list keeps the desktop's latest facts.

```text
home-only Root (no projectService)
  ProjectSidebar -> listWorkspaces ─┐   desktop workspace-list-updated ─┐
                                    └-> workspace rows (late responses dropped) <-┘
  bridgeable row   -> switchWorkspace -> bridge Root (home page)
  disconnected row -> reconnectWorkspace -> desktop reconnect owner -> list returns remoteSessionId -> bridgeable row
```

Mobile sends a project/host intent, and the window Host calls the same ProjectService.prepareSession to resolve the
directory; mobile does not prepare first and have main prepare again. Main only forwards the request and the
sanitized workspace descriptor returned by the Host, and reads no project/task database. Every user create of a
global task allocates a new directory, and a retry of the same navigation request must not create twice. When
several navigations join the same directory scope they share the first-Provider-config sync barrier; a scope
generation change invalidates the old bridge identity at once. A scope created by mobile and later explicitly
adopted by desktop still waits for desktop renderer ready before it counts as connected.

Remote admission may only reuse an online physical Source connection of the current window and create or reuse the
logical scope for the directory in that window's Registry; it must not implicitly establish a new
SSH/WSL/Docker/URL transport, standalone Host or Agent. Before and after preparation it verifies the retained
host's membershipId and the physical connection owner, and again after the scope is created; late results of
removal/generation change are rejected. Offline keeps the current bridge and draft, and explicit reconnect runs
through the original entry.

The mobile scope's remoteSessionId, workspaceIdentity and cwd must match the Host descriptor. A new scope still
creates an independent subscription via the existing shared-host attachWorkspaceHost with trusted
web-remote-replayable; the desktop continuous chain is unchanged. When the mobile Root is replaced it carries the
project draft, provider and initial input, finishes draft initialization first and only then allows prewarm; an old
Root does not write the new Root's state after an async return.

Uncommitted project membership is a browser draft like body/model: the optional projectId (null = explicit
unclassified) is saved in the existing V4 composer's workspaceKey + `__draft__` scope. Plain text/model saves must
not clear it, explicit New overrides it, and it is cleaned with the original draft promotion after task creation
succeeds. Mobile replayable Root rebuilds and page reloads read membership from the same draft; an explicit
initialTaskDraft wins and an existing initialTaskId reads no draft; desktop continuous still enters a new draft
with the original initial-workspace semantics. No project-state copy or accepted input queue is added in
main/relay.

```text
mobile draft edit -> existing browser composer scope (workspaceKey, __draft__)
bridge recovery / reload -> Root restores projectId before prewarm
first submit -> Host validates project -> CLI accepts -> existing draft promotion
```

Opening an existing task in the project tree uses this admission too: the client submits only taskId,
workspaceKey and the owning hostId; the Host confirms from the authoritative task tree that the address exists and
then runs resolveSessionDirectories; prepareSession must not be called nor a new directory allocated for a history
task. Remote first checks the retained Host and the online physical owner, then the locally retained project entry;
opening an unclassified task only requires the Host member to exist. All late results follow the same
membership/entry/physical-owner check. The bridge's workspaceKey stays the original execution-directory identity,
never the project ID.

```text
mobile project intent -> main request routing -> Window Host ProjectService
                                                     | prepare cwd
                                             online Source lease check
                                                     | Registry logical scope
mobile replayable <- existing shared-host bridge <- trusted descriptor
```

#### 6.0.4 Read-only boundary of composer project candidates

The old empty-state naming-scratch-workspace dialog and the Root -> App -> Shell creation callback chain are
retired. New directories are created solely by the selected virtual project's prepareSession or the global-task
allocation entry; no second creation action without an actual UI consumer is kept.

`#` reads candidates from the actual current Host's ProjectService.readTree, including non-deleted tasks of
directories whose tabs are not open, grouped by `(hostId, projectId)`; empty membership shows the localized
task-area title, and existing tasks under a soft-deleted container still show under that project name. It reads
only the current attachment's Host and must not connect another Host for candidates nor aggregate session IDs
that cannot be read. Each group is searched independently up to 20 entries, ordered by the CLI activity-time
mirror. Session candidates in `@` stay limited to the current workspaceKey, but their row set also comes from the
same authoritative project tree. Project events make the read-only query refresh; late results after an
owner/address change are discarded.

`@` file candidates cover the bound cwd and the project's other roots. Existing tasks use
resolveSessionDirectories; drafts use readProjects for the selected projectId; an unclassified draft has only the
current cwd. Reading candidates must not call prepareSession nor create directories or an Agent. A removed root
of an old task still keeps its own cwd. File lookup runs through the current Host's fileService with the real
absolute path as dedupe key; the original relativePath is kept, canonical links inside the current cwd stay
relative, and other roots use absolute paths so same-named relative paths do not point at the wrong file. The
root name on the right of a candidate is display only and takes no part in identity or execution path.

```text
composer # -> current Host ProjectService.readTree -> project groups
composer @ -> task directories / selected project roots -> same Host fileService
                identity + request owner changed -> discard old response
desktop continuous / mobile replayable -> original attachment, no new runtime
```

### 6.1 Task-area membership and first placement acceptance

Scheduled/off-peak project selection reuses readProjects, reading only directories and projects, without loading
the task tree or triggering auto-archive just to show candidates. The former "open local workspaces" becomes "all
non-deleted local virtual projects", keeping the existing product spec's local-create scope, fixed directory after
creation and old-remote task management; opening remote create needs a separate explicit ruling.

| Scenario | Expected |
| --- | --- |
| Global new task | created under `~/.zcode/workspace/<unique dir>` with `project_id = NULL`, shown in the task area |
| First discovery of a history session outside the default directory; bound directory matches exactly one non-deleted project on the same host | attached to that project, cwd unchanged |
| Same, but matches several non-deleted projects | stays unclassified in the task area; no primary-directory priority, no new project |
| Same, but matches no non-deleted project | stays unclassified in the task area, no new project |
| Directory matches only a deleted project or another host's project | not a valid match; stays unclassified; deleted project not restored, no cross-host attach |
| Unclassified session whose first judgment is done (bit 8); later a project containing its cwd is added; restart or reconcile | stays in the task area, not auto-attached though the directory became a unique match |
| Timeline session with empty membership dragged into a same-host project missing the directory | dialog confirms adding the real bound directory; confirm moves, decline leaves directory and membership unchanged |
| Empty-membership session meets F12 auto-archive condition | also auto-archived, not missed for lack of a project |
| Delete a local project or an online remote authoritative project | sessions keep their `project_id`, still visible in the timeline, not moved to the task area |

These scenarios behave the same on desktop and mobile Web remote; remote keeps the same-host restriction and
workspaceIdentity isolation.

### 6.2 Remote offline project entry acceptance

A remote Server's `host_id` uses the stable Source Server identity injected by the trusted startup entry. The
database `workspace_key` may keep the old SSH/WSL canonical key, converted to external identity by the existing
identity mapper; different physical hosts must not be inferred from these historical connection addresses, and
cwd, CLI config hash and canonical key are unchanged. Server Core finishes its own app-database migration before
creating services / opening RPC.

| Scenario | Expected |
| --- | --- |
| An added remote project is disconnected or failed to connect | local basics stay visible; cannot expand, rename or edit roots / primary; the only project operation is deleting the local entry |
| Delete a remote project offline, restart the app, reconnect the same host | the local entry and cache are gone and the project does not come back; remote project, roots, session membership and content unchanged; no pending-sync deletion |
| Refresh request sent, then the local project entry deleted, then the response arrives | the late response rebuilds no entry or cache and setting.json does not rewrite the removed remote item |
| On host reconnect the remote returns a removed project or a new other project | only locally retained entries are refreshed; the full list never adds projects automatically |
| User actively re-adds the same remote project | local entry restored with latest info, original sessions accessible; no new remote project, no E1a undelete |
| Delete one project entry of a host, or delete the host | the former keeps the connection and other entries; the latter removes only the local connection and its entries; neither deletes remote data |
| Connection drops during an online remote project delete without confirmed success | reports unconfirmed or failure explicitly; does not silently turn into local entry deletion nor fake remote delete success |

Desktop windows and mobile Web remote use the same local entry data source read and written by the existing Host
service; mobile keeps no extra editable entry list. The implementation phase adds service unit tests and
desktop / mobile E2E confirming that local entry removal does not change remote organization state or session
runtime state.

## 7. Migration (startup gate, one shared implementation)

The shared migration module is exported as `@zcode/shared/sqlite-migrations`; the CLI/desktop agent build subpath
mapping must derive from the shared package's exports, with no second hand-kept subpath list. The actual bundle
build and import belong to migration delivery verification, not just TypeScript source checks.

After the 2026-10-10 merge the upstream observable startup gate is used: the Host Worker prepares the app database
before business services initialize, then prepares the session database with the same CLI bundle's storage
preparation entry. The Worker must read old settings and pass them to project migration (never record first and
drop the old project seeds). Both sides reuse existing SQL, checksum, table-level backup and Repo; lock waits are
async and ready is published only after commit; no second session-migration implementation. Failure enters the
startup error/retry flow; retry skips completed databases by full migration ID idempotently and does not assume
atomicity across the two databases. A CLI normal database open still checks migrations, covering standalone TUI
and remote runs. Two differently named 0004 migrations and both sides' CLI migrations are kept, not overwritten by
sequence number; `0023_session_soft_delete_outcome` recognizes the same-content `0020` record already run during
development.

Migration ID note: this document's §5.2, §7.1, M8 and the "Migration ID naming" section use the original
`0020_session_soft_delete_outcome` and `0001_projects`. The 2026-09-14 merge
([Session Manage upstream merge](2026-09-14-session-manage-upstream-merge.md)) re-numbers them to
`0023_session_soft_delete_outcome` (CLI) and `0005_projects` (Host) and treats the old IDs as historical aliases;
both names refer to the same migration.

### 7.1 Generic migration runner (shared by both databases, extracted from the CLI runner)

```text
migration definition
  { id, appVersion, up: SQL | fn, touchedTables: string[] }   <- explicitly declares the tables it writes

runner (backup is only for failed-migration recovery; untouched tables are identical before and after, so
        table backup + untouched tables = the full pre-upgrade state)
  pending = entries of SQLITE_MIGRATIONS not recorded in schema_migration (unknown ids ignored, checksum mismatch errors, as today)
  tables  = union of pending[i].touchedTables
  1. backup: ATTACH <backupDir>/<db>.sqlite AS b; per table CREATE TABLE b.<t> AS SELECT * FROM main.<t>; DETACH
     space: needed = sum of those tables' sizes; current volume short -> other mounted writable volumes -> none fits: skip and mark skipped in backup.json
  2. BEGIN IMMEDIATE -> run each up -> INSERT schema_migration -> COMMIT
  3. on failure ROLLBACK, keep the backup; main shows an error (retry / open backup folder)

backup metadata backup.json: per table column list, row count, content hash (CLI database foreign keys
message/part/session_entry/session_target -> session are all ON DELETE CASCADE, so restore must prevent cascades)

restore tool (engineering use, scripts/, manual DELETE forbidden)
  restore connection PRAGMA foreign_keys=OFF -> BEGIN IMMEDIATE
  for each touched table: DELETE main.t; INSERT INTO main.t(<backup column list>) SELECT <same columns> FROM b.t (columns added by the migration keep defaults)
  PRAGMA foreign_key_check must be empty; per-table row counts and hashes must equal backup.json
  COMMIT; delete the matching schema_migration rows; any check failure ROLLBACKs and keeps the backup

mechanical guarantees
  one unit test per migration: on a fixture database compare content hashes of all tables before/after; only touchedTables may change, else fail
  schema.baseline.sql + CI diff: only added tables / columns / indexes allowed
```

Migration declarations: CLI `0020_session_soft_delete_outcome` -> `touchedTables: ["session"]`; app `0001_projects` ->
`touchedTables: ["tasks","task_groups","task_group_members","task_group_view_node_orders","task_group_workspace_bootstraps","automations","off_peak_tasks"]`
(group tables are read-only but included in the backup so the whole can be restored).

### 7.2 Steps

2026-10-19 first-upgrade ordering supplement: when upgrading from 3.15, whose controller never ran project
migration, the old `lastWorkspaceSession` local/remote mixed order is kept. Local reuses `projects.position`;
remote entries store a nullable `initial_position` used only to initialize the first sidebar order, and the
controller position is never written to the remote project. A separate additive migration writes initial
positions only when the same migration transaction actually executed `0005_projects`; databases that already have
`0005_projects` or the old ID `0001_projects` are not re-ordered, and old checksums are untouched. Only remote
entries carrying this migration marker replace the sort key in place when `legacy:<entryId>` resolves to a real
project ID; the existing ordering algorithm and preference owner are reused and the sort identity is not switched
globally. First-screen offline, connection completion, Host identity binding, refresh and manual drag after
upgrade all keep position; a rolled-back failure can retry and repeated starts do not overwrite the new order.

```text
3.15's A -> Remote R -> B -> first transaction saves 0/1/2 -> existing sidebar preference
                                  legacy:R -> project:R (same ordering slot)
```

VP28 supplement: real cold-start migration of local/remote mixed order and offline refresh; SQLite and React
regressions cover identity replacement after connect, same path on different Hosts, manual order, no backfill of
an old ledger and migration idempotency. It reuses the shared-host mobile directory and the same ordering logic.

```text
M0 probe: tasks-index lacks schema_migration or '0001_projects' -> enter migration; otherwise skip
M1 backup: table-level backup of both databases per 7.1 -> ~/.zcode/backup/<ver>-<ts>/
M2 create tables/columns (5.1, 5.3); local remote-project entries stay separate from remote authoritative projects
M3 hosts: 'local' + remote authorities parsed from tasks.workspace_key / setting.json remote entries
M4 tasks backfill: host_id, root_path (= workspace_path), cli_* copied from old columns as initial values; rows with `deleted=1` get handoff_pending |= 1, rows with `title_overridden=1` get handoff_pending |= 2 (historical Host facts pending handoff to the CLI, see 7.4)
M5 locally and remotely, only the retained project workspaces of the old lastWorkspaceSession -> single-root projects (name = directory name, name_overridden=0, primary = that root);
    first position follows only the original order of this Host's project entries in setting.json lastWorkspaceSession (same directory deduplicated; saved projects without sessions also kept); conversation entries do not take part. Historical tasks, recentProjects and Groups cannot enlarge the project set; removed directories and directories with only archived or deleted tasks do not rebuild projects. Unattached tasks follow F3 keeping cwd, title, time and archive/delete/pin/unread state; with settings missing or an empty list no project is inferred from task records. When the holding owner is not local the F8 remote exception adds: after the settings entries, in descending order of last task activity, create single-root projects for roots that are non-deleted, not `*/.zcode/workspace/*`, not conversation entries and have no same-directory project yet; attachment is still done by M6a's unique directory match.
    position is initialized only at first migration; with an existing ledger conversion is not re-run, not re-ordered from settings and generated projects are not cleaned automatically, preserving later user edits and manual order. Remote entries are still imported along the original Host/entry boundary and the local arrangement is never written as the remote authoritative project order; default manual mode reads position, explicit sort-by-activity or pinned keeps the corresponding display rules.
    All tasks under it get tasks.project_id = that project; scheduled/off-peak definitions match saved projects by same Host + workspace_path, a remote identity key is not a real directory; unmatched ones keep NULL and their original execution scope. The bootstrap group (task_group_workspace_bootstraps) no longer builds a project separately.
    Remote entries in the local lastWorkspaceSession are imported into remote_project_entries only on first migration, keeping basics and the original workspace identifier until connection resolves the remote project ID; no remote authoritative project is created locally. Saved Source/valid Profile also import connection membership, preferring an existing stable Source ID and preferred Profile; old-address entries link to the same stable Host and never-handshaken addresses keep a temporary address identity. After a migration ledger exists nothing is imported back from settings.
M6 converts only members of the current holding Host (superseded by the 2026-10-13 ruling for hand-made groups); locally left-over remote shadow members stay in the old tables as migration evidence and no remote authoritative project is created locally.
    hand-made group -> project: roots = deduplicated member directories, primary = most-populated; multi-host ones split by host with host name suffix; member project_id set to the new project; system groups skipped
M6a judge historical tasks still unattached after M5/M6 once per F3; do not overwrite existing project_id; zero or several matches keep NULL
M7 backfill project_id (workspaceKey -> its single-root project) and host_id for automations / off_peak_tasks, and freeze old definitions' additional_directories as [] (old versions bound only cwd; no expansion by later project roots)
M8 write schema_migration('0001_projects'); the four old group tables stay in place
every start: in one transaction first identify rows with host_id IS NULL added by older versions; fill their host_id/root_path and, for the still-unattached ones among them, judge once per F3 and commit.
  project_id IS NULL by itself does not mean pending migration; unclassified rows with host_id already filled are not judged again.
  A session newly found by the CLI is judged per F3 at its first insertion into the app table, writing host_id/project_id atomically; global new tasks write host_id and project_id=NULL directly.
  Then run the 7.4 fact reconcile (not recomputing project_id of existing rows); derive and write setting.json from the local projects/hosts and retained remote_project_entries (F5); old remote entries are not imported into the entry table again
```

### 7.4 Reconcile and handoff (every start + whenever a workspace CLI is available)

(There is no 7.3 in this document.)

```text
full-table comparison at start (about 4085 rows, milliseconds)
  deleted=1 AND cli_deleted=0                         -> handoff_pending |= 1   (delete intent of an older version or history)
  title_overridden=1 AND (cli_title_source<>'custom' OR cli_title<>title) -> handoff_pending |= 2
  updated_at / task_status disagree with the mirror   -> ignored (V1 reads only the mirror)

when a workspace's CLI is available for any reason (no Agent is started just for handoff)
  batch: bit1 -> deleteSession; bit2 -> renameSession(title)
  success -> clear the bit and let sessions-index write back the mirror; CLI says not found -> clear bit1 (treated deleted), set bit2 to orphan(4) keeping the app title

after the sessions-index subscription receives a snapshot
  rows with local cli_deleted=0 and absent from the snapshot -> sessionsIndex/reconcile
    deleted=true  -> cli_deleted=1 (and dual-write deleted=1)
    exists=false  -> handoff_pending |= 4, warning log, row not deleted
    exists=true   -> refresh cli_* from the returned values (the summary just has not arrived yet)
```

Display rules do not wait for handoff: hidden = `deleted OR cli_deleted`, title = `title_overridden ? title : cli_title`,
so the user sees the same before and after handoff. Measured on the dev machine: M2-M8 total 175 ms; table-level
backup CLI 70 ms (1.9 MB), tasks-index 165 ms (14 MB).

## 8. Phased MRs (same-version release)

| MR | Content | Main directories | Verification |
| --- | --- | --- | --- |
| 1 | CLI 0020 migration, time_deleted / last_outcome, deleteSession semantics, SessionSummary.lastOutcome, `sessionsIndex/reconcile` command, additionalDirectories consumers and V4 cold-resume parameter threading, skill/subagent qualifiedName | apps/zcode-cli | unit + protocol schema tests |
| 2 | Generic migration runner (extracted from CLI, adds touchedTables, table-level backup, restore script, per-table hash unit tests), 5.1 schema, space guard, run before window creation in main, schema.baseline.sql + CI diff | packages/services, packages/desktop/main, scripts/ci | unit: all branches + upgrade/downgrade fixtures |
| 3 | Ownership tightening: syncer writes only cli_* and old-column mirrors; remove 3 Date.now; renameTask / deleteTask go through CLI commands and write intent bits; 7.4 start reconcile, lazy handoff, snapshot-absence reconcile | packages/services | unit + e2e title / status regression |
| 4 | Project service: projects/hosts/roots CRUD, move session, soft delete and restore matching, 4.3.1 unified directory resolution with three-entry injection, F3 first placement and NULL organization-state preservation, setting.json dual write, warm-up moved to last active directory, auto-archive trigger moved to project-tree query (later moved to the Host scanner), local remote-project entries and cache, offline removal and no rebuild on reconnect | packages/services, packages/shared | unit: first placement, restart does not change membership, auto-archive of tasks outside the default directory; entry removal and late refresh |
| 5 | UI: project tree, task area, timeline, create / edit wizard, drag and confirm dialogs, context menu, pinned projects, remote nodes, remove toolbar and group UI | packages/ui | e2e: project CRUD, drag and reject, 6.1 task-area membership scenarios, 6.2 offline entry operations |
| 6 | composer and settings: @file suffix, qualifiedName list, # by project, settings directory source | packages/ui | e2e: 4.3.2 multi-root capability and cold resume |
| 7 | Scheduled / off-peak / Bots select projects | packages/ui/settings, services | e2e: scheduled task picks a project |
| 8 | Remote server bundle migration + old-remote degraded display + Web / mobile sidebar project hierarchy | packages/server, web, desktop/main | remote e2e: 4.3.2 concurrent subscriptions and remote directory resume; 6.2 offline delete does not change remote data, manual re-add |
| 9 | Doc write-back: retire the grouped / bootstrap / task-sqlite-index specs, pointing to this document | docs | - |

## 9. Risks and open verification

- 2026-09-10 review fixes: restore cascade-deleting content (7.1 foreign keys off + check), edits to existing rows
  during downgrade (7.4 full-table intent reconcile), handoff of historical Host facts (M4 marker + lazy handoff),
  delete reconcile source (`sessionsIndex/reconcile`). MR 2 / MR 3 unit tests must cover: message/part row counts
  unchanged after restore; `deleted=1` written by an old version still hidden after re-upgrade; old tombstone
  handoff and orphan; convergence through reconcile after a lost `session.removed`.
- Degraded display in the window where remote server bundle and local version mismatch needs real-device
  verification (SSH, WSL).
- CLI soft-delete visibility change for external TUIs (an old TUI still shows the session) is accepted and must be
  stated in release notes.
- `UNIQUE(host_id, task_id)`: if history data has the same task_id under different workspace_key on one host (ACP
  migration leftovers) index creation fails; before M4 probe and record conflicts, and on conflict the index
  degrades to non-unique with a warning.
- Unique project name per host vs old workspaces with the same directory name (two different `z-code` paths): M5
  adds a numeric suffix automatically.

Schema gate supplement: existing tables' CHECK, table/column-level automatic UNIQUE and index ordering/collation
are the old write contract; deleting or rewriting them must be rejected, and automatic indexes with
sqlite_schema.sql=NULL must not be missed. New constraints on old tables may make downgrade writes fail, so the
gate requires the CHECK/automatic-UNIQUE sets to stay identical; new tables may declare constraints freely. SQL
comparison normalizes only keywords/whitespace and keeps string-literal case so changed WHERE values are caught.
The check reads only an in-memory database and modifies neither migration history checksums nor the baseline.

Remote live activity reuses the shared subscription of WindowControllerTaskListRegistry. The project tree overlays
phase/pending interaction only by full workspaceIdentity/workspacePath + taskId and does not change the row set,
titles, organization state or CLI ordering time returned by SQLite. Task cwd/roots form observation scopes,
registering an owner observer through the existing listTaskList without creating a logical workspace or Agent.
Direct owner clients with no Controller keep using their own sessions-index. When the source goes offline or the
overlay is deleted, live attributes are dropped and an old running is not treated as a persisted terminal state.

The Renderer's remotePinnedTaskStore / remoteTimelineTaskStore, which no longer have readers, are deleted;
connection completion only commits attachment, directory identity and drafts and no longer reads the remote task
list for those two caches. Header organization commands still go through the original Host task service; the
query projection that Header/global search needs stays, without redundantly writing an unread remote-list mirror.
The project sidebar refreshes by its existing ProjectService query/mutation events.

D2 native drag: task rows serve both workbench copy and project-membership move, so the drag source's
effectAllowed must allow copyMove; the workbench keeps choosing copy and projects choose move. The Host moveTask
is sent only after drop; cancelling the missing-root confirmation changes no persistent state. A component test
that constructs a DataTransfer cannot replace browser-native event acceptance.

2026-10-16 remote project menu consolidation: an editable (online and not legacy single-root) remote project's
menu matches local projects and no longer shows "Remove from this machine" and "Add remote project"; remote sync
and connection actions are unchanged. "Remove from this machine" remains the only management action when not
editable (G5). Only the menu items are hidden; the logic of `removeEntry`, RemoteProjectPicker and `addEntry`
stays, and adding a remote project still goes through other entries such as New project and the picker after a
device connect.

2026-10-14 project menu icons: context, more and multi-directory file menus share action icons: new task
MessageCirclePlus, view files ListTree, edit Pencil, pin Pin / unpin PinOff, delete Trash2, remove entry
FolderMinus, connect Plug, add remote project FolderPlus, sync RefreshCw. Icons sit left of the text, uniformly
`size-4`, non-shrinking, `aria-hidden`, with the menu's `gap-2` and text color (including delete, disabled and
hover). Menu order, copy and actions are unchanged; desktop and mobile narrow screens keep icon-text alignment
under Zai Light / Zai Dark. A pinned project no longer shows an always-visible pin right of its name. On
hover-capable devices, when the mouse enters a project row the left icon switches to Pin within the same `size-4`
slot and restores the current folder or remote-connection icon on leave; unpinned projects and touch screens
without hover keep the original icon. Display is derived by CSS, with no new state and no change to title expand,
drag or menu pin actions. Acceptance covers pinned/unpinned, enter/leave, multi-directory expanded state, remote
icon, light/dark themes and narrow screen, with text and action buttons not jumping.

2026-10-13 multi-directory icon: a local project shows the multi-directory mark directly from the current
`project.roots.length > 1`, never inferred from task count, open tab count or current cwd. 0/1 roots use Folder /
FolderOpen, several roots use Lucide Folders / the matching FoldersOpen (the open version keeps the stacked outline
and opens the front folder). The sidebar picks open/closed icons by the existing expand state; the composer's
current-project chip and project options use the closed icon and add no menu open/close semantics. Both places
share one icon component, redraw directly after roots change, with no separate cache or persisted field. Remote
projects keep the existing connection status/cloud icon. Size, line width, theme color and accessible name follow
the host control. Acceptance covers 0/1/many roots, sidebar expand/collapse, composer current item/candidates and
roots going from many to single; it reuses the VP14 desktop and VP13 mobile cases, checking the actual shapes and
project selection path in both themes.

2026-10-13 D2 target feedback: dragging a session into an editable project shows a 2px blue outline
(`border-icon-blue`) and a light accent background (`bg-accent`) over the whole project container with
`rounded-xl`; scope covers the title and the currently expanded task list, a collapsed project covers only the
title and does not auto-expand. The decoration layer receives no events and does not change size. Feedback reuses
the native session payload and the existing project accept conditions, not mixed with the project-sort insertion
line. Moving among the project's title, tasks and action buttons keeps the highlight; leaving the project, drop or
dragend (including Escape) clears it at once. Unrelated file/text drags and offline/old read-only projects show no
feedback.

```text
session drag -> project dragenter/dragover -> whole project highlighted (renderer temporary state only)
              -> inner child node switch -> keep
              -> leave/drop/dragend -> clear
              -> drop -> existing moveTask / missing-directory confirm -> Host project membership
```

It reuses the VP15 native drag case, adding whole-block boundary, no layout shift, clear on leave/cancel, clear
before confirm, two-way move and light/dark screenshots. Native Escape is covered by the component dragend cleanup
regression; WebDriver key presses did not cancel Chromium's native drag, so desktop E2E verifies cancel by
dragging away from the project and releasing, and does not record that step as Escape verification. Mobile remote
does not enable native session drag (controlled uniformly by the Shell's split entry); this check covers the shared
project container at mobile narrow width in both themes and asserts that entry stays off, adding no touch gesture.

```text
project tree (SQLite rows) ---------------------+
existing Controller -> sessions-index activity -+-> keyed UI overlay
                 metadata cursor/gap repair; conversation delivery unchanged
```

The Controller's metadata snapshot/gap coordination keeps the existing protocol.

Remote project change notification: after a successful handshake the physical-connection owner subscribes to that
connection's `state:projects` and forwards it as a "needs re-read" notification on the same local channel; project
data is not passed through and no cache is written. SourceManager and URL Registry each hold and release their own
transport's subscription; late events after generation change or disconnect are discarded by original connection
object identity. After the Controller re-reads the remote authoritative database it runs CAS refresh only on
locally retained entries and cannot add entries from a broadcast. No other settings/state channel enters this
bridge.

Every standalone Server entry that provides project RPC uses the same Host assembly: stable serverId -> app
migration (owner hostId) -> workspace identity mapper/alias service -> createLocalServices(standalone-server) ->
HTTP/RPC. It keeps the CLI canonical workspace key, and both HTTP and ServerCore translate stable remote identity
through the same mapper. Only an entry that completed this assembly declares virtualProjects; if migration fails
the port is not opened. Config directories still follow cwd/identity and serverId takes no part in real-path
computation. The settings service's config file address is fixed to that Host's HOME at instance creation;
async projection, migration and the write queue read/lock/replace along the same path and must not write across
Hosts after later environment variable changes. Standalone-server assembly integration tests must use a
child-process-level temporary HOME, and the parent process must not revoke isolation while background tasks may
still run. A brand-new URL Server working directory without SSH/WSL/Docker route hints gets its own stable server
identity as the first canonical key; registered aliases and legacy keys with history always take precedence, and an
entry upgrade never rewrites an old CLI identity. A new alias allows a legal server route while real IO still uses
cwd.

H2 implementation boundary: the settings-page candidates come from the pure project directory read
(readProjects): all non-deleted local project roots plus roots of retained online remote projects, deduplicated by
workspaceIdentity/path; the task tree is not read and tab membership is not used to decide whether a directory
exists. Tabs only supplement an existing remoteSessionId/localWorkspacePath. Candidates use the config directory
type; synthetic tab IDs and fake sessions are forbidden. Before a remote response returns, members/entries are
re-read, and after a remove-then-re-add old results are rejected by membership.

The desktop config hooks may request the existing Source settings attachment, only after a root is selected; the
physical connection stays owned by Registry/SourceManager; the config set exposes no Agent and is not a session
resume chain. Mobile keeps the original trusted workspace attachment and the Source settings permission boundary
is unchanged. Before writing config for a remote workspace without an open logical workspace, the config
attachment binds the cwd's canonical key through the existing sourceServerWorkspaceService. The Host's legacy
route hint is only for existing history resume; until binding finishes the state stays remote-waiting, and old
results after a target/attachment generation change cannot open writes to a new target. Source settings still
exposes no Agent, task, file or provider write entries.

Scheduled/off-peak definitions added during a downgrade are marked unhanded-off by `host_id IS NULL`. Each start and
task-intent reconcile fills the owner in one transaction, decides project membership once by the same-Host unique
root, and fixes additional_directories to the old-version-supported `[]`; the current project's multiple roots do
not widen the old definition's execution scope. Definitions whose host_id is already filled (including a legal NULL
project_id) are not recomputed, existing directory snapshots are not overwritten, and neither workspace_key/cwd nor
historical migration checksums change.

UI scope invariant: the project sidebar footer's remote-control entry still receives the current execution
workspacePath, workspaceIdentity and remoteSessionId; the project display refactor must not drop this identity
chain nor infer remote ownership from cwd.

Directory ownership for remote project navigation: ProjectService prepareSession / history tasks already provide
the owning Host's cwd and workspaceIdentity; the Renderer hands this pair to the existing Host bind and must not
realpath again and rebuild identity from a different path. A normal folder pick still resolves canonical path in
the original directory browser. The Host keeps identity/member validation and the UI keeps exact-identity
verification of the bind result; owner checks are not relaxed for path aliases such as `/tmp` vs `/private/tmp`,
and historical cwd is not rewritten.

```text
Host project/task -> fixed cwd + identity -> existing Host bind -> exact identity check
folder picker     -> existing canonical resolver -> existing Host bind
```

The V4 remote replaceable transport must fully forward createSession's client context (projectId), including after
a service proxy generation change. projectId is not part of the CLI envelope but must reach the owning Host's
prepareSessionCreation so membership is reserved atomically and additional directories resolved before the CLI
creates; the recovery proxy layer must not truncate this parameter and the Server must not guess membership from
cwd. When reopening a remote history task reuses an already-bound tab, only the extra temporary logical attachment
requested this time may be released; if the passed sessionId is that tab's owner it must be kept, and an
attachment that still carries a task must not be cancelled because reuse succeeded.

Cold resume and runtime generation change: an in-flight subscribe ACK must still be discarded across generations.
`fault.subscription.runtimeRestarted` is a known generation-change interruption that enters the existing bounded
subscription recovery and must not become a permanent error; no committed command is replayed, no new queue or
second retry timer is introduced, and the desktop continuous / mobile replayable subscription and recovery
semantics keep their original boundary.

```text
subscribe in flight -> runtime available/restart -> old ACK rejected
                  -> existing bounded subscription recovery -> current owner ACK
```

## 2026-09-11 user UI corrections and migration supplement (override older UI rulings)

- Keep this project's project row and section interactions; restore project/task collapse, section drag order and
  hover actions with the original preferences. The project section's add is Plus, the task add is
  MessageCirclePlus. The timeline capability stays but its entry is not shown for now; project sorting moves into
  the title context menu. A project row has no standalone arrow; Folder/FolderOpen express collapse state;
  hover/focus/touch keep three buttons "more, view files, new task". The context menu contains view files, new task
  and all operations of the more menu, and supports keyboard menu key/Shift+F10 and touch long-press.
- The create wizard first picks local/remote, then name and source folders. Name uses a combined input with a
  folder icon, and source folders use a whole clickable add area; the path input belongs only to the directory
  browser. 0-root projects stay legal. Remote may pick a saved connection or add one in the wizard, and pick an
  existing project or create a remote project; the sidebar offers no standalone "add connection".
- When the name is focused only the existing outer ring of the combined input remains; the inner Input stacks no
  outline; autofocus, mouse click and Tab return all follow this, consistently in light/dark, narrow screens and
  forced-colors mode. DIALOG-FOCUS-01 in `ui-shell/manual-review/pending/command-center-focus.test.ts` verifies the
  shared creation dialog and exits by cancel without writing a project.
- Reuse the existing connection dialog, directory browser and Host service; no workspace tab or Agent is created
  to browse directories. Connections belong to the connection manager, the form holds only drafts, saving belongs
  to the owning Host; after cancel/target switch late UI results are rejected. A local entry is added only when an
  existing project is explicitly picked or a new project is saved successfully.

```text
create -> local/remote -> connection manager (remote) -> file service picks directory -> Host.saveProject
                                                                    |
                                       local entry <- remote save succeeded
```

- (Superseded by the 2026-10-13 ruling.) Hand-made Group migrates only with non-deleted session members; empty
  Groups, dangling-only and deleted-only members create no project; archived but non-deleted members stay valid.
  Name and valid member directories are kept; explicitly created empty projects are unaffected.
- The already-run SQL/checksum of 0001_projects stays immutable; only the first-upgrade conversion branch is
  repaired. Already-migrated dev data is not bulk-deleted by name; local repair must verify sources via the old
  Group, members and the migration backup and, after backup, clean only empty containers proven wrongly migrated
  and unreferenced by tasks/schedules.

Project directory selection routes by hostId via projectService.readDirectory to the owning Host and reuses that
Host's fileService/systemService. The UI DirectoryBrowser only adapts this contract, shared by desktop and mobile;
it does not depend on the desktop-only Source settings attachment nor parse/create workspace identity. The query
reads/writes no project database and starts no Agent; a nonexistent path or dropped connection is an explicit
error. While the create wizard connects a saved Host, other connection entries and the back action are paused until
the connection completes or fails, so two connection flows cannot run at once.

### Migration ID naming

Both databases use a four-digit zero-padded per-database increasing number plus a `snake_case` semantic name
(`NNNN_description`), never mixing product version or schema codenames into the ID. The task-index first versioned
migration is uniformly `0001_projects`, later ones increase from `0002_...`; the CLI's `0001_base_session_store`
to `0020_session_soft_delete_outcome` stay unchanged and each database numbers on its own (see the §7 note for
the later renumbering to `0005_projects` / `0023_session_soft_delete_outcome`). This only corrects the name
`v3_projects` used during development: SQL text, checksum, app_version, run time and data conversion logic are
unchanged. A formal upgrade uses the new ID; local databases that ran this branch's dev build do one-off
maintenance that verifies the old checksum, backs up, and updates only schema_migration.id inside a transaction.
No historical alias or second conversion path is added to the public runner, and already-run data is not treated as
a first upgrade and re-migrated; local maintenance must verify that all business-table contents are unchanged.

### Project-row shortcut supplement

The more dropdown and the context menu reuse one action definition, both non-modal, and the shortcut buttons do not
trigger row collapse. View files reuses the existing WorkspaceFileTree: single root opens directly, multi-root
picks via the file button menu; zero roots keep a disabled button and create no directory or task. An offline
remote still allows only removing the local entry and never uses the local file service to read remote paths. The
file-tree display target belongs to the sidebar UI, the project collapse state belongs to the resident sidebar by
Host + project ID and survives going back from the file view. Remote connect/bind belongs to the existing
connection manager; a workspace binding is requested only on an explicit view-files, and mobile uses only the
trusted shared-host switchWorkspace. A late old open request must not override a new selection.

```text
project row click / right click -> same action definition -> pick root
  local -> existing file tree(path)
  desktop remote -> existing Host connection and workspace binding -> file tree(path + identity + sessionId)
  mobile -> shared-host switch -> bound file tree
```

### Project editor source-folder list (2026-09-11 user correction)

- Zero roots show a whole block "添加 ZCode 可读取和编辑的文件夹" (add folders ZCode can read and edit); once a root
  exists it becomes one bordered list whose last row is FolderPlus + "添加文件夹" (add folder), and the big empty
  card is no longer shown. Each root row shows a folder icon, the last directory name (full path in title), and
  on the right a "主要" (primary) mark or "设为主要" (set as primary) button, plus a remove button.
- "Set as primary" changes only the editor draft; saving writes through the existing saveProject(primaryRoot) to the
  owning Host; cancel writes nothing. The first directory is primary by default; removing the primary picks the
  first remaining; removing all leaves no primary. New tasks use the latest primary via prepareSession; existing
  tasks' cwd is unchanged.
- When editing an existing project the delete-project button returns at the bottom left; no delete button on
  create. It keeps deleteProject's soft-delete semantics, deletes no files or tasks, adds no confirmation layer;
  remote must pass the original hostId, failure stays in the dialog with the error and never degrades to local
  removal. Save/delete share the submit mutex, then refresh and close on success.
- Form drafts belong to ProjectEditor, persistent state to the Host projectService, reusing the existing directory
  browser and API; no schema, migration or sync queue is added. Light/dark, long paths and 390px layout must be verified.

```text
set primary / remove root -> editor draft -> save -> owning Host.saveProject
                                                 -> new task prepareSession takes the primary
                                                 -> old task cwd unchanged
delete project -> owning Host.deleteProject -> refresh -> close editor
```

### Old product experience kept (2026-09-11 final user confirmation)

This section overrides sorting and display rules simplified during implementation. Old Groups with their colors,
manual member ordering and sticky titles are not restored; clicking a project only collapses/expands and does not
enter a directory draft. The previously hidden timeline, archive and standalone connection entries are not
restored. Everything else follows the old product experience:

#### 2026-09-14 sidebar regression fixes

- Delete order stability (2026-10-15): project menu, editor delete and offline entry removal all update the
  authoritative directory only through the existing commands. Between the command returning and the directory
  refresh the project keeps its place; once the new directory arrives it disappears directly and other projects'
  relative order is unchanged. Deletion does not clear controller sort keys early (else projects in the old
  directory would be appended as unsorted); the existing rule that preferences keep the position of temporarily
  invisible projects applies, and a failed refresh keeps the old directory and order. No deletion copy, timer or
  animation compensation. Desktop and mobile keep sharing the directory owner and remote commands still route by
  the original hostId.

```text
delete / remove entry -> owning service command -> authoritative directory refresh -> project disappears from its place
controller sort preference ---------------------------> other projects keep relative order
```

- "已置顶" (pinned) restores `text-ui-base font-medium text-foreground-subtlest`, aligned with the left edge of
  the project/task section titles (about 18px). Pinned tasks restore the outer 8px horizontal margin. Section
  titles regain the 8px outer margin without stacking on project rows.
- The "Tasks" section's session list shares the 8px left margin with sessions inside projects; the full-row hover
  background, text, empty state and pagination entry all inset together; light/dark and 390px layout are the
  same (2026-10-14 correction).
- The project list restores dnd-kit vertical sort displacement and transitions, with pointer and keyboard support.
  Within the same pinned area swapping across Hosts is allowed; only the current controller's sidebar preference is
  written, never the remote position. Dragging a task into a project still uses the native session payload and
  moveTask and does not trigger project sort. Click, menu, new and file entries do not accidentally start a drag;
  Escape cancels with no write.
- The Host is the sole owner of committed project order; during drag there is only a UI transform, drop commits via
  reorderProjects then refreshes, and failure keeps the authoritative tree and shows a notice.
- Expanded empty projects and empty task lists of an online Host show the i18n `taskList.noTasks` (zh-CN "暂无任务"),
  keeping the old task-text indentation; an empty pinned area shows no title or empty state, and offline/loading
  states never fake "no tasks".
- The system `~/.zcode/workspace/default` was once built into a project by first migration because the old settings
  lacked/mis-wrote purpose. A one-shot `0006_default_workspace_tasks` (not changing the published 0005 SQL/checksum)
  corrects only auto projects created by the old migration whose single root is the system default and that were
  never renamed/edited: task project_id is cleared and the mis-built container soft-deleted. A default under a
  normal path and hand-made/renamed/multi-root projects stay. It writes only Host tasks/projects; task cwd, CLI
  mirrors, pinned/archived/unread and scheduled/off-peak execution snapshots are unchanged. The migration has a
  table-level backup, rolls back on transaction failure and does not recompute membership on repeated starts.

```text
drag -> UI displacement -> same-Host reorderProjects -> Host order -> readTree
old-migration default project -> 0006 transaction -> tasks.project_id=NULL -> original task area
                                       -> projects.deleted=1 -> mis-built project not shown
```

Acceptance: VP31 (font size/indent/empty state, pointer sort animation, keyboard cancel/sort, order after refresh,
light/dark and 390px); VP28 adds the system default upgrade with mislabeled purpose and task retention. Storage unit
tests cover existing ledger, first upgrade, Windows paths, archived/pinned/unread and other-table hashes, same-name
hand-made projects and idempotency. Real mobile/SSH/WSL not run must be listed as a limit.

- Project and unclassified lists default to 5 items, +5 each time; the pinned area keeps the "已置顶" title,
  defaults to 20, with show all and show fewer. Pagination does not reset on equivalent snapshot refreshes.
- For projects and pinned tasks running/prewarming come first; the running layer sorts by CLI created time
  descending then taskId descending; the normal layer sorts by the created/updated time preference with the other
  time as second key, taskId descending. The original comparator is reused; Host organization modification time or
  Date.now must never be written into ordering; the CLI fact source and the UI sort policy are separate boundaries.
- The created/updated time choice sits in the project title context menu, clearly distinct from project container
  sorting; the old task time preference is still read. Project container sort mode and the Host+projectId collapse
  preference persist in the browser; a local single-root history project may initially read the original workspace
  collapse preference, an explicit new preference wins, and old Group state is not read.
- Current-task highlight must match both the Shell's current workspaceKey and that workspace's activeTaskId.
  Desktop reuses the existing remote-control state subscription and shows the mobile-access marker by full
  workspaceKey+taskId.
- A collapsed project with unarchived unread members shows a blue dot of the original size right of the project
  name, including pinned tasks that still belong to the project and excluding same-ID projects of other Hosts. When
  expanded the task rows show unread; clicking expand does not clear unread. Unread derives from Host readTree with
  no counter table or sync state; offline with no task facts shows no fake unread.
- A successful archive clears the matching task UI state and the current task leaves the detail, same as Header;
  failure keeps the session and shows a notice. Pin/unpin shows an in-flight intent first, undoing with a notice on
  failure; authoritative rows still come from the Host. In-flight pin of the same task is limited by the full task
  address and a late old response must not overwrite the new tree. Unread keeps the expectedUnreadAt CAS.
- Ordinary task rows have no right-side file-tree button; pinned-area tasks restore the view-files entry
  (2026-10-12); project rows keep view files. Scheduled-task/plugin buttons restore their selected state.
- Remote projects restore the original Skills/MCP/Plugins sync quick menu and original platform scope (desktop
  online SSH/WSL; mobile gets no new sync capability); sync uses existing dialogs, workspace services and refresh
  flow. Remote uses the single fixed directory as operation scope, forbidding appending or merging other root
  configs; no RPC is sent for an unready attachment.
- Connection rows reuse the existing reconnect log display and failure details/copy; connection progress belongs to
  the connection manager and the UI builds no separate connection state machine. List errors and concrete
  connection errors are shown separately.

Layering: project-sidebar is a UI module and pure selectors only derive data; the preference hook manages display
preferences only; the task-interaction hook adapts only existing task commands and in-flight UI intent; remote
operation components adapt only existing connection/sync interfaces. Business ownership, command validation and
persistence stay in the Host Service, with no new Repository, fact cache or accepted command queue in the UI. The
existing TaskList gains only necessary optional display parameters/file callbacks and stays compatible with other
callers.

```text
Host readTree + CLI activity -> pure selectors -> sort / collapsed unread display
Shell active workspace + task UI -> selected state; mobileViewState -> mobile marker
user pin -> UI in-flight intent -> existing Host command -> authoritative refresh -> release intent
                          failure -> undo intent + notice
user archive -> existing Host command succeeded -> clear task UI + refresh
remote menu -> existing workspace attachment -> original sync dialog / service
```

No schema/migration or local database change. Regression covers full local/remote identity isolation,
refresh/failure/late results, 390px and light/dark themes; real mobile/SSH/WSL not run must be listed as a limit.

Connection diagnostics: remote-projects.readDirectory takes the connection manager's status/error from the same
assembly port and clears the old error as soon as it returns to online; neither is written to SQLite. Project
connection progress reuses the existing AsyncLocalStorage requestId log chain correlated with hostId+membershipId;
the UI shows only the current member's logs, so remove/re-add cannot receive an old member's logs. No new
connection owner or retry mechanism. The connection log port keeps using `TransportContext.onLog`: Host assembly
injects a unified reporting callback and the management service only passes it to the existing manager's connect
context; no new connection-state owner. The project file tree keeps the current root/Host routing and trusted
shared-host attachment; closing or a new selection invalidates late file targets.

Pin intent lifecycle: it covers only the in-flight period of the Host command and this authoritative refresh;
it is released when the refresh completes (or fails), not when the queried value equals the expected one. Another
client may change the pin in between, so the latest Host fact must be shown and a finished intent must not stay as
a second state.

### Project collapse animation and task-row entry correction (2026-09-11)

Project expand/collapse reuses the Collapsible, CollapsibleTrigger and CollapsibleContent used by the old
WorkspaceSidebarItem: a 300ms height transition and content fade in/out, with the task list unmounted only after
the collapse animation ends; fast reverse clicks are driven by the same controlled open value without extra timers
or another collapse state. The collapse preference still belongs to useProjectSidebarPreferences; expanding does not
navigate or change unread, and offline cannot expand. Project, unclassified and timeline rows show no file-tree
button. Pinned-area tasks restore the right-side view-files entry: reuse TaskRowActionButton and the ListTree icon,
shown on hover/focus/touch; click selects no task and changes no unread, and opens the task's frozen workspacePath,
not the project's current primary directory. A local task does not depend on an open tab; a remote task offers the
entry only when a session of the matching identity exists, never falling back to local file reads. Mobile first
reuses the trusted workspace switch; project and task file open/close share one request sequence number so a late
switch cannot override a new selection or close. The project row's view files, archive/pin and original context
actions stay.No Host/CLI or workspaceIdentity change, no schema/migration change.

```text
click project -> original collapse-preference owner -> Collapsible.open
                                  -> height/opacity animation -> unmount content after collapse
fast reverse click ----------> same open value updates (no extra timeout)
```

The shared Collapsible's opacity animation must act on child layers directly through the current content's
data-state and must not use a same-named group selector that can hit any ancestor; with nested project nodes in the
project area an outer open must not override an inner closed fade-out. Height is still driven by the current content
itself with no extra animation state.

### 2026-09-11 supplement: composer project picker shares the sidebar source

- The project picker lists the sidebar's full non-deleted virtual projects, including unopened directories, zero
  roots, custom names and locally retained remote entries; it no longer reads workspace tabs and is not truncated
  to the first 5. Project order reuses the sidebar preference; pinned projects come before normal ones, order inside
  a group unchanged. Search copy is "搜索项目" / "Search projects" and matches project name and roots.
- The `project-sidebar` window-level Provider alone owns the project tree read and preferences; sidebar and
  composer read the same projection. The Host remains the sole authority for projects, roots and remote entries;
  the UI writes no database and makes no second project cache. Read errors are shown explicitly and do not fall
  back to tabs. Offline/unresolved remote entries are visible but not selectable.
- The selected state takes the draft `projectId` and the workspace's Host identity, so different projects with the
  same cwd are independent. No membership shows "选择项目" (Select project). A pick only calls the existing
  `onCreateTask({projectId, hostId})`; Root/Host `prepareSession` prepares the primary directory (auto-fills zero
  roots) and enters the draft; it never infers membership from directory nor starts an Agent for display. The cwd
  and membership of submitted sessions are unchanged.
- Original menu look, search, remote connection and the "work outside project / detach" entry are kept; long lists
  scroll inside the menu. Project rename, removal and order changes show in both places.
- 2026-10-13: the bottom "打开文件夹" (open folder) is replaced by "创建项目" / "Create project" (reusing
  `project.create`). Selecting closes the menu and mounts the sidebar's same `ProjectCreation` with its
  device/name/roots, directory trust confirmation, save and refresh flow. The default device also matches the
  sidebar: an existing remote session takes its device, otherwise local. Save or cancel opens no workspace, creates
  no session and changes no current project/draft; after saving the new project can be picked explicitly from the
  shared list. Mobile also uses the project service, unaffected by the native open-folder capability switch; adding
  a new remote device keeps the original capability limits. After a new remote connection is completed in chat it
  enters the mandatory directory flow per [#21](../../issues/remote-connection-ux/21-chat-settings-round-trip.md);
  ordinary creation uses the default device above independently and does not inherit the connection result.
- 2026-10-13: the composer header shows a Plus quick button after the branch selector (the plugin entry in office
  mode), with tooltip and accessible name "编辑项目" / "Edit project". It shows only for the currently selected
  editable project; no membership, deleted, offline or old read-only projects show nothing. The current project is
  still resolved by the same menu by projectId + Host, not by cwd. Click opens the sidebar's same `ProjectEditor`
  directly to rename and manage directories, keeping the original delete and remote limits. Save/delete go through
  the original project service and refresh the shared directory; cancel writes nothing; editing triggers no task
  creation or directory navigation and the text draft is kept. When chat/draft identity changes the old editor is
  invalidated and must not revive on switching back. The shortcut is enabled only by the chat shell; automation
  and other reusing pickers get no new button.

```text
Host readTree + retained remote entries -> ProjectDirectoryProvider -> sidebar / composer
composer create / sidebar + -> ProjectCreation -> ProjectEditor -> directory confirm -> Host saveProject -> refresh
                         -> cancel / save done -> current session and draft kept
composer + -> current projectId + Host -> ProjectEditor -> Host saveProject / deleteProject -> refresh
           -> cancel -> current session and draft kept
user selects {hostId, projectId} -> existing Root createTask -> Host prepareSession -> draft
 desktop: existing continuous navigation
 mobile: existing shared-host attachment -> replayable navigation
```

Async reads reuse the existing request sequence numbers and remote membership checks; no new stream, owner,
accepted queue or persistence migration. Mobile reuses only an already-online Source and still goes through the
original shared-host admission, creating no other runtime.

### Current-task metadata and auto-archive wrap-up (2026-09-11)

- Detail metadata is read from the Host index (CLI fact mirror + Host organization state) through the existing
  workspace-scoped `ZCodeTaskService.getTaskMeta`, no longer from the CLI active runtime's `readSession` and no
  longer depending on whether an old list/query cache happens to contain the current task. An archived history task
  opened directly can still read its title. When the first send has not yet reached the index only the existing
  uncommitted optimistic metadata is reused, with no new fact writer.
- Detail reading is owned by the existing active-task hook; it re-reads on current-workspace list changes, the
  existing taskListVersion and projects broadcasts. Requests are isolated by service/attachment + workspaceKey +
  taskId, a later request wins, and switching identity or unmounting drops late results. Failure is logged; the
  previous task's title must not fill the current task and the CLI is not restored for a title.
- The auto-archive criterion, the seven-day retroactive effect and the unread CAS are unchanged. When the project
  tree accepts a new result, only a task with the same Host + workspaceKey + taskId going from `archived=false` to
  `true` triggers the existing `removeTaskState` to clear this window's selection/detail; manual, automatic and
  other-client archive behave the same. First reading an archived record, an offline missing row, removing a
  project entry or a failed response is not treated as an archive event; explicitly opening an existing archived
  history is still viewable.
- On auto-archive the current detail exits to the original workspace draft and does not auto-select the next
  same-name task. Navigation and drafts are still owned by the existing session UI store; the project read hook
  only compares two accepted snapshots, persists no second archived copy and adds no sync timer.
- Remote metadata goes through the existing scoped service/attachment; archive cleanup sends no stop/delete CLI
  command.

```text
CLI facts -> Host tasks-index <- Host archive command / auto-archive
                 |                              |
         getTaskMeta + change events      readTree accepted result
                 |                              |
           current task detail title      false -> true -> removeTaskState
Content: desktop continuous / mobile replayable, each resuming via the original V4 subscribe
```

Acceptance: AMT01 a cold history task reads its real title before content resumes and syncs after rename; AMT02
(rewritten 2026-09-14, then 2026-09-15): with the seven-day archive on, a 28-day-old read and an unread task are both
archived, a pinned old task and a 6-day-old task stay, and opening the 6-day-old unread task only clears unread and
keeps it open; AMT03 an archived history task opens explicitly and is readable, a missing row/offline/late query
must not wrongly clear the current selection; AMT04 same path with different remote identity, task switching and
out-of-order returns do not mix titles/archive. Unit tests cover timing and isolation; pending E2E covers the real
Host/SQLite/renderer, with desktop and mobile/remote evidence reported separately.

### Auto-archive trigger detached from UI actions (2026-09-14, maintainer)

The maintainer ruled that tasks meeting the criterion should already be gone from the list, so archiving must not be
triggered by "clicking a session". The earlier trigger sat on the project-tree query `readTree`: open an old unread
task -> CAS clears unread -> the sidebar refreshes by taskListVersion -> readTree incidentally runs archiveInactive
-> the just-opened task is archived within 1 second and leaves the detail, which the user perceives as "cannot
open" (reproduced via CDP on 2026-09-14).

- The trigger is the Host periodic scanner (`packages/services/src/project/autoArchiveScheduler.ts`): one scan
  when services are assembled, then every 5 minutes (shortened from hourly on 2026-09-15); changing
  `taskAutoArchiveEnabled` / `taskAutoArchiveOlderThanDays` triggers an immediate re-scan. Scans are serial, and
  repeated requests during a scan merge into one re-scan; desktop-attached-remote does not start it and the remote
  Host scans its own database.
- `readTree` / `readProjects` are read-only; the project service no longer holds an `autoArchive` / `beforeRead`
  entry; click, refresh and task switch change no archived.
- The criterion is unchanged; the "currently viewed completed task" is still not exempt (2026-09-11 ruling): when
  the periodic scan hits the current detail, the project tree's existing false -> true cleanup exits the detail as
  usual.
- The `workspace_task_list_changed.reason` values `auto_archive` / `realtime_sync`, which no one emits, are removed.

```text
settings change --+
start first run --+-> scheduler.scan() -> archiveInactive(cutoff, activeTasks) -> publishProjectChange -> project tree false->true -> removeTaskState
every 5 minutes --+
click task -> setTaskUnread(CAS) -> V4 subscribe            (no longer enters the sidebar chain)
```

Scanner first-run/interval/settings re-scan/serial merge/dispose are covered by unit tests.

### Auto-archive criterion becomes purely time-based (2026-09-15, maintainer)

The user saw a 31-day-old `error` task still in the list and ruled "purely time-based, pinning unaffected". Local
data: among overdue, read, unarchived tasks there were 324 error and 346 with no CLI result, which the old criterion
(completed only) kept in the list forever; unread is also no longer a protection.

- `archiveInactive` criterion: `archived=0 ∧ pinned=0 ∧ deleted=0 ∧ cli_deleted=0 ∧ cli_updated_at < now − N days ∧ host_id = this Host`, then excluding `activeTasks` (sessions the syncer observed as non-terminal, as a safety net). Unfactual reserved rows with `cli_updated_at` NULL fail the comparison and are not archived.
- Archiving changes neither unread nor CLI facts; an archived unread task still carries unread in archive
  management.
- The scan interval changes from 1 hour to 5 minutes; the triggers stay first run, periodic, and settings re-scan,
  and hang on no UI action.
- The settings-page copy reads "将最后活动时间超过保留期的任务自动归档；置顶和运行中的任务不受影响" (tasks whose last
  activity exceeds the retention period are archived automatically; pinned and running tasks are unaffected).

Repository unit tests cover the pinned / running / recent / nofacts exceptions and unread / error / NULL archiving.

### Auto-archive re-enable after the fix (2026-10-14)

When the old versions' auto-archive did not work, users may already have switched it on. After the fix, history
sessions must not be bulk-archived in the first upgrade scan from the old value alone; the user must re-enable it in
the new version.

- A settings migration adds the internal marker `taskAutoArchiveResetVersion: 1`. When the raw settings lack the
  marker, `taskAutoArchiveEnabled` is reset to `false` once and the marker is written, keeping
  `taskAutoArchiveOlderThanDays` and other settings. New users still default to off.
- It reuses the full settings schema's migration entry and SettingService's write queue, file lock, in-lock re-read
  and atomic write. `get()` returns only after the migration is persisted; on write failure the scan fails and does
  not continue archiving from the old enabled value. Concurrent reads must not overwrite a choice the user just
  saved.
- After the user re-enables it from archive management, the settings commit event triggers an immediate scan; later
  restarts, repeated reads and upgrades keep the user's choice. The marker is used only by settings migration, the
  scanner still consumes only the switch and retention days, and the UI gets no new state or confirmation dialog.
- Each Host's SettingService migrates only its own config; remote tasks are executed by the remote Host, and
  desktop-attached-remote does not migrate remote settings on the local machine.
- Session data is untouched, previously archived sessions are not restored, and neither the criterion, interval nor
  retention days change.

```text
Host first/periodic scan -> SettingService.get -> in-lock re-read of old config
                                          ├─ no marker: turn the switch off and write the marker
                                          └─ marker: keep the current choice
                                      -> persisted -> return policy -> decide whether to archive
user re-enables -> SettingService.update commit -> settings event -> immediate scan
```

Acceptance AMT05: old config enabled with overdue sessions -> cold start -> switch off, days kept, sessions still
there; manual enable -> old sessions archived; cold start again -> switch stays on. Unit tests cover new config, each
old switch value, repeated migration, concurrent read/write, independent Host settings and migration persistence
failure; E2E reuses AMT02's isolated history fixture and stays pending. Passed once on macOS Electron (cold start off,
archive after manual enable on real SQLite, second cold start stays on); real mobile pairing, SSH/WSL and
Windows/Linux GUI not run; independent Host settings isolation is covered by service unit tests.

## Sidebar search and view switch (2026-09-15, SBV01-SBV06)

This section overrides the earlier rules "timeline entry hidden, project/task sorting in the right-click menu,
reading the old time preference".

- The navigation area (new task, automation, plugin market) is separated from the list area by a 1px
  border-border/50 divider that extends over the sidebar's right 4px resize area; the decoration receives no
  pointer events and does not change drag size or interaction; when switching to the file view the line hides with
  the task list; the list header is 12px below the divider and 8px above the list scroll area. The list area has an
  independent fixed header that does not belong to the navigation component nor enter the list scroll and fade
  container; project/task sections scroll independently below it. The header shows a title and search/filter icon
  row: the overall title on the left is "任务列表" (Task list; section titles unchanged), on the right Search then
  ListFilter. Both icon buttons are icon-sm (24px) with 14px icons and 4px spacing; the overall title uses
  text-ui-lg (default 16px) and secondary text color text-foreground-subtle, section titles stay text-ui-base
  (default 14px) and text-foreground-subtlest. The search entry is a button with an i18n aria-label and a shortcut
  tooltip (title and shortcut parameters passed separately, shortcut reuses ControlShortcutBadge without joining a
  separator); click still calls the original Shell global search and shows no input or permanent shortcut text; no
  new search state or shortcut listener. Light/dark, desktop and mobile share the layout.
- The filter menu has only two items "By project / Recently updated" with Folder / Clock icons on the left and a
  check on the right for the current view; the two groups of sort options in the project section's right-click
  menu are removed and other project/task actions stay.
- By project: keeps the pinned, project and task sections with no Host grouping; projects sort manually by the
  current controller's composite-identity preference; tasks: running/prewarming first, running layer by created time
  descending with taskId tie-break, normal layer by updated time descending. Projects/unclassified 5/+5, pinned
  20/all/fewer.
- Recently updated: takes all unarchived tasks from the same ProjectTree, including pinned, unclassified and history
  under projects deleted in the tree; shows no project or Host groups; restores date headings today, yesterday,
  2/3 days ago, this week, last week, this month, last month, earlier; no separate pinned area, each row appears
  once. Strict updatedAt descending, then createdAt, taskId descending, with stable tie-break on the full
  Host/workspaceKey/taskId; running state does not change order. First screen 20, +20 each time, refreshed data does
  not reset the count; re-entering the view starts from the first screen.
- Recently updated reuses the existing timeline two-line task style: first line status and title, second line on the
  left the last name of the task's bound working directory (not the virtual project name), on the right the
  relative update time and the original meta. A task with no status shows no dot but keeps the icon slot to align
  with the title; unread/error/running/pinned/mobile-active states follow the shared row rules. By project still
  uses compact single-line rows.
- A date heading appears only before the first item of an adjacent date segment of the already sorted and paginated
  result, takes no pagination quota, does not create duplicate task groups and does not change the full task key.
  Dates are computed by the client's local calendar and language (en-US week starts Sunday, zh-CN Monday), crossing
  days by calendar date to avoid daylight-saving errors; recomputed on refreshed projections/re-renders. Appended
  pages do not repeat a segment heading, time changes may reorder across segments, and an acting row is kept by its
  full task identity.
- Selectors and the render layer receive the display mode explicitly so the render layer does not reapply
  running-first. Sort time comes only from the CLI mirror, never from Host organization modification time or
  Date.now; pin does not affect time order, and after a successful archive the task leaves both views.
- The only preference owner is useProjectSidebarPreferences in ProjectDirectoryProvider. The existing
  zcode-project-sidebar-preferences gains view=projects|timeline, default/invalid value falls back to projects, and
  expanded is kept. The old sort and zcode-sidebar-task-preferences.sortBy are no longer read, old collapse is kept,
  Host position is only a first seed, and project display order is stored per controller as order=[hostId,projectId].
  If localStorage is unavailable the current window can still switch; desktop and mobile save preferences
  separately.
- Switching views does not change task membership, the current task or project collapse; the composer project
  picker keeps sharing the directory and shows manual project order, ignoring sidebar view switching. No
  Host/CLI/RPC/SQLite change.
- Local/remote task sources keep the original project-tree visible scope and create no new connection or task cache
  for the list; identity is still Host + (workspaceIdentity.trim() || workspacePath) + taskId.

```text
user choice -> shared preference owner -> current client localStorage
                    |
Host readTree + CLI time mirror -> pure selectors -> project list / recently updated list
search click / original shortcut -> Shell -> existing global search
task action -> existing Host command -> authoritative tree refresh -> current view re-derives
```

Impact surface: presentation / option-source / persistence. Navigation, ProjectTaskRows, the view selector and shared
directory preferences must be checked; the composer project menu is a shared consumer of order, and archive
management is only regression-checked on the row-set boundary. No new async owner, queue or sync policy.

### Accepted acceptance

| Case | Setup -> Action -> Assertion | Non-UI evidence |
| --- | --- | --- |
| SBV01 | plugin-market navigation -> click the search icon / original shortcut -> same global search, menu has two items only, correct platform keycap | Shell callback / keyboard test |
| SBV02 | expand/collapse projects and open a task -> switch view/refresh -> current task and collapse kept, view restored | localStorage, navigation store |
| SBV03 | project/unclassified/deleted project, pinned/running/archived, same-path tasks across Hosts -> recently updated -> pure time, no duplicates, no archived | pure selector fixture / Host tree |
| SBV04 | old created/updated preference and manual position -> load -> old sort ignored, composer and sidebar project order identical | localStorage, directory read count |
| SBV05 | more than 20 tasks -> more/refresh/time update/pin/archive -> continuous pagination, reorder, pin does not move rows, archive removes | fixture mirror and command results |
| SBV06 | desktop and real mobile shared-host -> search/switch/reopen -> same task identity, desktop tab/Host count not increased | Host process, navigation store, identity |

Cases land first under manual-review/pending, reusing isolated HOME and case-local fixtures; pure list assertions send
no model requests. Light/dark and 390px screenshots do not replace real-phone verification. Confirmed prunes (not in
this change): global search scope expansion, old sort options, archive mixing, remote connection policy and
model/provider combinations; no open product questions.

Verification: desktop E2E (SBV01-05, old project interactions, 1200/390px light/dark screenshots) and a mobile E2E in
Chrome for Testing at 390x844 (hasTouch/isMobile) through a real relay/shared-host passed. Mobile evidence is browser
touch emulation over the real shared-host chain, not a physical phone; Windows/Linux shortcuts are unit-tested only;
cross-Host same-path / same-taskId sort identity is unit-tested with no SSH/WSL real-machine run.

## Sidebar slide animation for view files

Clicking a project's "view files" moves the project navigation out to the left and the file tree in from the right;
returning slides back. It reuses a 200ms ease-out transform animation, keeps both panels in the DOM during the
switch, and the leaving panel is non-interactive and hidden from assistive technology. It respects the reduced-motion
setting. On close the logical open state is false at once and the last file target is kept only until the browser
exit animation finishes; then the file tree unmounts, releasing the directory watcher, cancelling pending refresh
tasks and discarding late results. With reduced motion or no actual animation it unmounts immediately; no fixed
timeout decides business lifecycle. Reopening during exit cancels the old unmount; switching targets reuses the data
layer's workspace cleanup, and late directory resolution is still discarded by the original request sequence number.
Desktop and mobile share this behavior with no change to directory identity, theme or language.

## Task list scroll-edge fade

The project view and the task timeline share the scroll container and reuse ScrollFadeViewport's 24px mask. With no
overflow there is no mask; at the top only the bottom edge fades, in the middle both edges, at the bottom only the
top edge. It recomputes after content or container size changes; the navigation bar and the bottom account area do
not take part in the mask. The list's original spacing, vertical scroll and drag boundary are kept; desktop and
mobile, light and dark share the opacity gradient with no added color or business state.

MR !2897 mobile file navigation: validity of a connection is proven jointly by the authoritative session mapping of
identity and the actual services registration, without requiring sessions to duplicate an identity field. A
cross-workspace `workspace-bridge-open` locates the trusted task cwd with `fileTreeTaskId` and `taskHostId` and must
not carry the selected task's `taskId` or a project draft at the same time. The Host reuses task directory
preparation and sets no `initialTaskId`; the new mobile Root opens the file tree initially, selecting no task and
clearing no unread. A pending return request of an old Root still follows the original generation cleanup. After the
file tree closes the open request the shell already consumed is cleared, and a sidebar remount must not consume the
old entry again.
