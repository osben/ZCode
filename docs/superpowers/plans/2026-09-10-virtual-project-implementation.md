# Virtual project implementation record

> Historical implementation record (2026-09-10 → 2026-09-14), kept for its contracts, deletion
> ledger, acceptance matrix and open follow-ups. Development surprises, failed rounds and root
> causes live in the [deviation ledger](2026-09-11-virtual-project-development-deviations.md) —
> D50 (test isolation wrote real settings; recovery boundaries) must not be erased from the record.
> Full history: git show 45f808f7:docs/superpowers/plans/2026-09-10-virtual-project-implementation.md

## Feature summary

| Field        | Decision                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Goal         | implement `2026-09-09-virtual-project-design.md`, delivered in §8 order                                                   |
| Layers       | presentation, option-source, draft-default, validation, commit-effect, persistence, recovery                              |
| Seeds        | `taskIndexRepo`, `createZCodeTaskIndexSyncer`, `IZCodeTaskService`, `WorkspaceSidebar`, `V4Gateway`, `SqliteSessionStore` |
| Out of scope | workbench split groups, queue owner, bridge identity, directory hash, plain session config resolution chain               |

## UI surface matrix

| Surface                              | Shared implementation                              | Draft / default                                     | Validation & commit                             | Authority                       | Mode boundary / isolation                                                    |
| ------------------------------------ | -------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| Sidebar projects / timeline / pinned | project query, task row components                 | UI keeps only collapse and sort preferences         | Host project CRUD / move                        | app SQLite                      | same ownership desktop/web/mobile; remote has its own Host                   |
| New task                             | existing createSession chain                       | project primary dir; global gets an independent dir | Host resolves roots then creates                | CLI session + app membership    | cwd fixed after creation                                                     |
| Open history / reconnect             | V4 subscribe and cold resume                       | task carries explicit project_id                    | Host resolves dirs from one read snapshot       | CLI single-flight runtime       | continuous / replayable each with own subscription; live roots not refreshed |
| Composer files / skills / sub-agents | existing capability discovery and suggestion lists | current task directory scope                        | qualifiedName / path                            | CLI capability catalog          | no merging of attached dirs' settings, MCP, hooks                            |
| Settings Agent config                | directory picker                                   | all roots deduplicated                              | existing directory config service               | directory-level config          | virtual project is never used as path or config identity                     |
| Scheduled / off-peak / Bots          | their config editors                               | project primary dir plus remaining roots            | execution config frozen at creation             | each Host repo                  | later project roots edits are not followed                                   |
| Offline remote project               | local entry list                                   | last-success basic info cache                       | only entry removal; edits go through the remote | local entries / remote projects | late refresh only UPDATEs; rebuilding entries is forbidden                   |

## Shared and divergent behavior

- must-inspect: CLI store → sessions-index → Host syncer → task index. The CLI is the sole writer of
  session facts; the Host only mirrors.
- must-inspect: project service → create / resume / V4 cold subscribe. Directory resolution is
  unified in the Host; the UI never assembles roots.
- must-inspect: schema runner → desktop startup / remote server / CLI startup. Table-level backup,
  fail-closed on transaction failure.
- should-inspect: directory options and creation defaults in composer, settings, automations,
  off-peak, Bots.
- conditional: SSH/WSL/Docker/server reconnect and legacy single-root remote degradation.
- invariant-only: CommandInbox, owner/lease, workspaceIdentity, mobile replayable, desktop
  continuous.
- evidence-only: existing session-store, v4-cold-resume, sessions-index, task index, task
  title/unread unit tests and the TSL E2E series.

## State owners and commit sinks

```text
CLI db.sqlite ── facts / sessions-index ──> Host syncer ── cli_* ──> app SQLite
                                           ↑                         ↑
                                 rename/delete commands      project/pin/archive/read

task + project roots (one read snapshot) → Host → create/resume/cold subscribe
                                             ↓
                                    CLI single-flight runtime init
desktop continuous ───────────────────┤
mobile replayable ─ snapshot/gap ─────┘
```

Organization columns keep only their own values; CLI timestamps are never synthesized from Host
`Date.now()`. Title/delete intents persist until handover confirmation; a missing snapshot is
re-queried via reconcile, never treated as deleted. Session directories, workspace identity and
remoteSessionId do not change when a project moves.

Offline title/delete commands reuse the CLI READY cold recovery: CommandInbox first checks the
idempotent result and obtains session admission, then initializes the runtime, then runs the
original command. A repeated delete returns the recorded result instead of resurrecting the session;
the Host keeps no second command queue.

```text
rename/delete → CLI CommandInbox (dedup, FIFO) → READY → original handler → CLI facts → Host mirror
```

## Refactor boundary and deletion list (2026-09-11)

The task was an explicit refactor: trace old task-management dependencies, then delete the replaced
implementations; no parallel writers. `session` / `services` are unmanaged directory splits only and
are not evidence of completion.

| Old implementation                                                          | Action                                                          | New responsibility                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| TaskOverlay / overlays / applyOverlayToMeta                                 | deleted                                                         | Host SQLite organization state read through services; UI keeps uncommitted drafts only |
| adapter.updateTaskIndexFromStreamEvent                                      | deleted                                                         | sessions-index / reconcile is the sole fact ingestion                                  |
| applyAgentPatch, snapshot status merging, shouldPreserveNewerTerminalStatus | deleted                                                         | CLI writes explicit last_outcome; live phase is display-only                           |
| Host-first rename/delete with best-effort CLI sync                          | deleted                                                         | CLI command confirmation → syncer reads facts; failures keep the old value             |
| closeTask writing deleted                                                   | deleted                                                         | close only releases the runtime; delete is a separate command                          |
| task_groups management, mixing, workspace auto-grouping                     | runtime API/UI/sort cache deleted after migration               | project / roots / task.project_id; old tables only feed the first migration            |
| full snapshot write-back of title/status/time                               | fact writes deleted; search body and display info stay separate | display cache must not write `cli_*`                                                   |
| legacy data compatibility                                                   | limited to startup migration and lazy handover                  | no permanent fallback or second runtime implementation                                 |

```text
CLI command / session store                         Host organization
  title / deleted / activity / outcome                project / pin / archive / read
                |                                                  |
      sessions-index + reconcile                         project service contract
                |                                                  |
        one facts projector ----------------------> app read model
                |                                                  |
       generic topic transport                         project tree / timeline
                |
 desktop continuous / mobile replayable (each keeps its own recovery boundary)
```

CommandInbox, owner/lease, remote attachment and session runtime protocol adapters are out of scope
of this refactor; deletions require reference evidence — code still serving mobile, bots, or
cross-Host routing is not dead state. Every new module ships the five-piece architecture set, runtime
input validation, failure semantics and contract tests. Completion is reported as deletions and net
line counts, not module counts.

## Must-preserve invariants

Follow session-management I1–I17 (I17's old "timeline-only" wording yields to ruling A5/F3: empty
membership goes to the task area). Databases take additive columns/tables/indexes only; historical
migration checksums are untouched; restores disable foreign keys, validate table by table, and commit
without deleting bodies. After a normal runtime instance initializes, its directory scope is fixed;
cross-Host drags are rejected; a missing root requires explicit confirmation before the atomic write.

## Codegraph evidence

CodeGraph had no workspace index; impact analysis used targeted retrieval over the seeds above
(call entries, authority owners, adjacent tests), never static reachability as functional
dependence. The old grouped-task-list graph is replaced by the project tree.

## Clarifications and boundary decisions

- The §3 ruling record outranks older "multi-match → primary dir" / "no match → timeline-only" text.
- `0019_dwf_journal` already existed; the soft-delete migration is `0020_session_soft_delete_outcome`
  — existing migrations and their numbers are never edited.
- Initial architecture gate 0 baseline / 0 new; full freshness fetch hit HTTP 504 (`--no-fetch`
  passed; remote freshness unconfirmed at the time).
- The pre-existing untracked `packages/remote-desktop/` is unrelated and was never modified.

## Acceptance dimensions

| ID   | Setup → action                                                                                                                                         | Assertion                                                                                                      | Evidence layer           |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------ |
| VP01 | old DB with bodies → upgrade / backup restore                                                                                                          | only touchedTables change; message/part intact; checksums unchanged                                            | SQLite fixture / unit    |
| VP02 | upgrade → old writer deletes, renames, creates → re-upgrade                                                                                            | intent handover, orphans, empty membership judged once                                                         | SQLite fixture / service |
| VP03 | cold seed omission / lost delete event → reconcile                                                                                                     | exists/deleted distinguished; absence never deletes a row                                                      | protocol / CLI / Host    |
| VP04 | 0 / 1 / many roots → create, edit, soft delete, same-set restore                                                                                       | cwd fixed, names unique, same host, cancel is side-effect free                                                 | service / UI E2E         |
| VP05 | NULL membership, 0/1/many matches → first discovery / restart                                                                                          | only a unique match is adopted, once; any cwd lands in the task area                                           | service / UI E2E         |
| VP06 | projects A+B → create / explicit resume / subscribe cold resume                                                                                        | B skills/subagents/writable scope available; AGENTS/config only A                                              | CLI / Host / E2E         |
| VP07 | live B→C change / primary dir swap / same-cwd dual projects / concurrent subscribe                                                                     | live scope fixed; rebuild by membership; no cross-use; single-flight                                           | unit / E2E               |
| VP08 | offline entry removal + late refresh / restart reconnect → manual re-add                                                                               | no resurrection, no remote mutation; re-add keeps original ID                                                  | repo / service / E2E     |
| VP09 | overdue unpinned old task (outcome/read ignored) → Host scheduled scan / settings-change rescan (since 2026-09-14 not triggered by tree load or click) | any cwd auto-archives; pinned/running exempt; organization ops don't reorder; clicking doesn't change archived | unit / E2E               |
| VP10 | create scheduled/off-peak/bot in project → edit roots → resume execution                                                                               | keeps frozen cwd/additionalDirectories                                                                         | unit / E2E               |

## Pruning decisions / unresolved questions

Excluded by rulings: cross-Host move (D2/G2), live roots refresh (B15), auto-project for empty
membership (F3), full project deletion (E1b). Core behavior was settled in the spec's ruling record;
desktop/mobile and local/remote each keep representative cases; Linux/Windows/real-SSH checks that
never ran are never marked passing.

## Handoff notes

Contract/spec first, then failing tests, then implementation. New GUI cases go to
manual-review/pending with isolated HOME, real SQLite and deterministic provider fixtures; reuse
existing E2E helpers; no automatic promotion. Evidence is backfilled into this file and the
conversation catalog/matrix after each stage.

## Implementation result (2026-09-11)

Database migrations, one-way task-fact ingestion, project/roots, sidebar, old Group retirement,
global independent cwd, CLI-activity-based archiving, desktop/mobile navigation, composer, config
directories and scheduled/off-peak/bot binding are all wired. Scheduled/off-peak keep the existing
"create only into local projects" restriction; remote projects and plain remote sessions can be
created. Mobile keeps its no-settings-page product boundary.

Managed modules and their ownership:

| Module                                     | Sole responsibility / state owner                                                                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| sqlite-migrations / startup-storage        | shared async migration runner for both DBs, table-level backup, verified restore, fail-closed before window creation |
| project-storage / project                  | Host project/roots/task-membership persistence; unified create/resume/cold directory resolution                      |
| task-facts                                 | sole ingestion and handover owner of CLI facts; organization state never writes `cli_*`                              |
| remote-projects                            | Controller connection members, project entries, basic cache; remote organization stays in Source                     |
| project-catalog / bot-project-runtime      | project candidates and frozen bot execution binding; routed through existing Source/Registry                         |
| project-workspace-navigation               | shared-host draft/history admission and generation guards                                                            |
| project-sidebar / workspace-config-catalog | project display and config directory candidates, both read via service contracts                                     |

Deleted: TaskOverlay, stream-event task status write-back, Host-first rename/delete then best-effort
sync, Group management API/UI, old workspace auto-grouping, old timeline/pinned/archived sidebar,
consumer-less remote task caches, the Scratch dialog callback chain, and the bot main bridge. Kept
query projections still consumed, CLI CommandInbox, owner/lease, workspaceIdentity, remote
attachment. Normal runtime instances have a fixed directory scope; definition-type tasks store an
immutable execution snapshot.

Net source delta (staged numstat, excl. docs/config): +24,859 / −39,226 (−14,367). All new modules
registered with policy, five-piece sets and runtime contracts; architecture baseline unchanged.

### Verification evidence (with boundaries)

| Check                                   | Result / boundary                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full affected unit tests                | final round 9: 1724 files / 14942 tests passed; 2 files / 14 tests skipped by config                                                                                                                                                                                                |
| Both DB schemas                         | round 3: real migration artifacts + additive-only constraint checks; CLI historical SQL/checksums preserved                                                                                                                                                                         |
| Architecture gate                       | final round 69: violations 0 / baseline 0 / new 0                                                                                                                                                                                                                                   |
| Type & lint                             | typecheck 87 passed; lint 48 warnings / 0 errors; format check on 460 changed files passed                                                                                                                                                                                          |
| Desktop & URL remote                    | round 53: 8/8 — migration ledger, global unique cwd/NULL membership, CRUD/same-roots restore, offline entries, URL metadata/real agent/extra root/reopen/cold resume, scheduled definitions, config roots, bot auth JSON                                                            |
| Composer & drag                         | round 52: VP14/15 — same-name multi-root files, project-grouped references, native drag with cancel/confirm on missing root, fixed cwd, body readable after move                                                                                                                    |
| Mobile shared-host                      | rounds 34/36/40/48: 390px, real relay, project draft reload, send/task-switch reopen, taskId/projectId/cwd/body and desktop tab/Host counts verified. Rounds 52/54 were blocked before navigation by a relay WSS certificate error (D91) — not recorded as a passing combined round |
| Local multi-dir full cold resume        | rounds 42/48/52: CREATE/LIVE used A+B; after full Electron/Host/CLI exit, COLD with same taskId/cwd used A+C; AGENTS always only A                                                                                                                                                  |
| URL remote agent cold resume            | rounds 52/53: VP18 — old CLI exited, new runtime identity, real COLD model request includes C's skill but not B's; taskId/cwd/projectId fixed; Controller holds no remote-authoritative task copy                                                                                   |
| Old-source upgrade/downgrade/re-upgrade | four phases passed on an independent old checkout (see below); not equivalent to an installed-binary upgrade                                                                                                                                                                        |
| Bot runtime                             | 193 targeted unit tests + 3 synthetic E2E (round 52); real remote third-party send/stream not executed                                                                                                                                                                              |

Round 52 (`desktop-e2e-20260911030401818-p18811-a137ff2609ad1117`) was 12 pass / 2 fail (VP11 read
text during menu animation; VP13 hit relay TLS handshake failure). After fixing the VP11 wait
condition, round 53 main file passed 8/8. These must not be merged into "latest full round all
green". New interaction cases stayed in manual-review/pending.

D82 (web transport intermittent wait timeouts under parallel load) is recorded as unresolved: both
pre- and post-refactor checkouts pass in isolation; the load-correlation explanation is a
hypothesis; timeouts were not loosened. D91's mobile WSS error has CDP/screenshot evidence
(Proxyman CA); the certificate anomaly is not claimed fixed.

### Cross-version data verification recipe

Old checkout `ad1fc7d414ee71c58d3539efdeb028b5d6e2e8f4`: `pnpm install --offline --ignore-scripts
--frozen-lockfile`, then `pnpm exec tsc -b apps/zcode-cli/packages/contracts` (no new-workspace
symlinks to old code). Run `scripts/verify-project-upgrade.mts <checkout root> <phase> <isolated
dir>` via the current Node tsx loader, phases `old-seed` → `upgrade` → `old-write` → `reupgrade`.
The isolated dir name must start with `zcode-project-upgrade-`; HOME/USERPROFILE/ZCODE_DATA_BASE_DIR
point at it before every process start. Old TaskIndexRepo/SqliteSessionStore seed real data, the new
build upgrades, the old build renames/deletes/creates, the new build re-upgrades. Bodies/FK, old
checksums, existing membership, first membership of new rows, old intent handover and cleanup all
verified. In-process CLI talks to the real Store; the old CLI still listing soft-deleted sessions
is an accepted degradation.

### Unverified scope

No run evidence for: real old server binaries, SSH/WSL, Windows/Linux GUI, real remote bots, mobile
remote execution, Source server process restart, in-flight remote permission interaction, Docker
preset. The local multi-dir model-request E2E does not replace separate tool-permission/settings/
MCP/hooks assertions. The final gates (round 9 full affected tests, type/lint/architecture,
changed-file format) passed. The runtime provided CODEX_SESSION_ID, matched against session_meta.id/cwd
and used for the commit.

## Residual cleanup (2026-09-12)

User review found the deletion list was not fully executed. Three evidence streams were crossed:
manual area audits (services fact layer / storage & identity / UI / shared-desktop-web / CLI /
tests & docs), knip, and import reachability ("unit tests are not entries") comparing every file's
production importers between 58c1b0d484 and the tree — the last caught a class knip misses: source
deleted, helpers kept alive only by unit-test imports.

Deleted batches:

| Batch                      | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Main locations                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Orphan modules             | 27 UI modules with no production consumer (~2,900 lines) and 23 tests existing only for them, incl. WebRemoteControlTaskIndex(.Row), buildTaskListResultFromSessions, taskStatusUnreadSync, workspaceTaskListDisplayGroups/OptimisticOverlay/RefreshSignatures, taskListRefreshPolicy, taskListWorkspaceEventCoordinator, WorkspaceSourceGroupHeader, workspaceSourceGroups, CollapsedRail, workspaceSidebarSelection, taskTimelineGroups, workspaceRemovalSafety, chatStatus, workspaceSourceConnection, sidebarTaskPreferences, workspaceRuntimeRelease, restrictVerticalDragWithinContainer, workspacePurpose, workbenchNewTaskTarget, chatActionHelpers, useLocalWorkspaceScopes, TaskListRemoteSyncHint, taskRuntimeDisplayStatus; taskListMetaSync kept only the two functions still used by bot broadcast | packages/ui                       |
| Mobile task snapshot chain | Root's three useGlobalTaskList → IPC SyncWebRemoteControlTasks → main availableTasksByWindowId → the tasks field of workspace-list/bootstrap, whose only reader died with the old mobile home; displayStatus/pinned/archived fields used only by that old home's signature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | shared, desktop main/preload, web |
| Dead service interfaces    | closeTask, createTask.draftSessionId (incl. sameModelSelection), taskIndexRepo.listSessionsByAutomation, TaskIndexWriteRecord.writeUnreadAt/searchableText with @write_unread_at CASE, syncer refreshSessionFacts, ensureSessionSubscription.includeSnapshot, ISettingService.ensureDefaultProject, ProjectCatalogContract, resolveStartupWorkspacePath                                                                                                                                                                                                                                                                                                                                                                                                                                                          | packages/services, desktop main   |
| CLI archive field chain    | SessionInfo.time.archived / timeArchived / includeArchived / archivedAt (shared protocol + services params), explicit time_archived=null on createSession, orphan ensureParentDir / SchemaMigrationRow, cold-session-resume triple-ternary compatibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | apps/zcode-cli, shared, services  |
| Copy & comments            | 116 unreferenced i18n keys × 2 languages; comments still describing grouped/overlay/applyAgentPatch/closeSession                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ui, services, CLI                 |
| Docs                       | sidebar-task-view-switcher.md and CLI multi-workspace.md got deprecation banners; the E2E matrix and case catalog retired Group-semantics cases (TSL22/27/37, CWP05)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | docs                              |

Incidental fixes: off-peak busy detection was dead (tasks-index rows mirror CLI last_outcome, never
"running"); added `IZCodeTaskService.listActiveTaskIds` from the syncer's active set, host now uses
it. Fixed two stale tests (pinnedTaskFileTreeAction asserting a removed button; a missing
useTabStore mock after 8d06343e22). Core resume now refuses to resume soft-deleted sessions.

Verification per batch: `tsc -b` per package, oxlint/oxfmt on changed files,
`pnpm architecture:check --changed` (0 violations), three rounds of affected unit tests (1715 files
/ 14789 tests), CLI-side recursive typecheck. `v4-gateway.test.ts`'s "Core admission ACK does not
wait for TurnStarted projection" was already failing on the pre-cleanup HEAD — unrelated, not
handled.

### E2E switched to the new sidebar test ids

47 e2e files (15 formal specs) still depended on dead workspace test ids via helpers. Helpers were
switched to the project sidebar: `ensureProjectExpanded`, `waitForRestoredProjects`,
`openWorkspaceDraftFromSidebar` (hover project row → create-task), `openProjectFileTree`,
`removeRemoteProjectEntry`, `reconnectRemoteProjectHost`, `readTaskRowInProject`; project rows are
located by `data-project-name` = directory basename (first migration of an old workspace produces a
same-named single-root project). Removed `selectTaskOrganizeMode` and app.page tabBar/workspaceList
getters; test-ids.ts dropped 9 dead constants and added `TID_VIRTUAL_PROJECT_*`,
`TID_PROJECT_PINNED_TASKS`, `TID_REMOTE_PROJECT_HOST` (registered in the testid contract). Group-view
-specific specs and their 4 fixture JSONs deleted; marquee fixture lost the group tables; wdio.conf
fixture branches updated.

Ran: workspace-file-tree-refresh, task-list-archive-confirmation,
conversation-session-conversation-workspace, conversation-session-task-title-marquee,
repo-wiki-generation-settings,
workspace-agent-warmup-small-set/-lifecycle, workspace-passive-agent-startup,
workspace-provider-save-dormant-agent, browser-tab-close-cross-workspace (warmup fixture
expectation changed 3 → 1 per spec F13; TSL29/31/36 docs updated). Not run: the SSH series (no real
SSH; helpers only made semantically consistent), remaining repo-wiki/workspace-file-tree/\*/
configurable-data-directory/pasted-image-path-projection/markdown-preview specs (same helper path
covered by the above), ~30 manual-review/pending specs with mechanical replacement only.
`workspace-removal-runtime-release` demoted to pending: whether deleting a project should release
that directory's agent runtime awaits a ruling. src follow-ups: project section needs
`data-primary-root` (same-named directory projects are currently indistinguishable);
project-sidebar still hardcodes testid strings instead of the new constants.

### Kept pending rulings (not deleted; product/design decisions)

- `taskIndexRepo.applyCliFacts`' "take newer / keep old terminal" SQL merge
  (`cli_updated_at=max(...)`, `cli_last_outcome=coalesce(...)`): the snapshot-status merge the
  deletion list ordered removed still lives as SQL; D15 solved late arrivals with request
  generations; two tests premised on the deleted applyAgentPatch still pass because of it
  (zcodeTaskIndexSyncer.test.ts:1839-1922).
- Two unread sources coexist: window badges read the store's taskUnreadByTaskId /
  optimisticTaskListByTaskId / taskListCache; the sidebar reads the task query cache's unreadAt; the
  new sidebar ignores the former but WorkspaceHeaderSections still writes them.
- Legacy group tables still maintained at runtime: controllerRemoteIdentityMigration.ts and
  sourceServerWorkspaceAliasRepo.ts still write the task*group* tables inside identity-migration
  transactions (~150 lines), although spec F2/F4 say post-migration they are written once, read-only;
  taskIndexRepo.initialize still creates the four tables for new DBs; mergeTaskDatabase merges only
  old columns, not cli\_\*/project_id.
- Small legacy-column read violations: listDeletedTaskIds reads only `deleted`, not `cli_deleted`;
  an old index is on updated_at while queries use cli_updated_at (fixing needs a new migration); the
  legacy ACP migration reads old columns every startup outside the runner.
- Permanent triple-legacy fallback in bots/workspaceHelpers.resolveCanonicalWorkspaceId; six
  unsupported adapter stubs plus checkCodexConnectivity / getTaskTokenUsage (legacy ACP surface, zero
  calls); the `apply` column compatibility branch of CLI migration 0020; the
  `packages/ui/src/workspace-grouped-tasks/` directory name (one live file; ProjectNode.tsx had
  uncommitted user changes, left alone); unreachable branches of TaskList.tsx and the TaskListItem
  timeline variant.
