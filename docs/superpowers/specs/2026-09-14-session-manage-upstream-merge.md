# Session Manage Branch Sync with Upstream

2026-09-14: the user approved merging `feat/multi-device-remote-3-real-ssh-feature` (`243b87c2c0`) directly into
`feat/session-manage` without a worktree. This branch's migration IDs and definitions move later; upstream
migrations run first.

Full history: `git show 37b98ff8:docs/superpowers/specs/2026-09-14-session-manage-upstream-merge.md` (merge
verification record).

## Migration contract

```text
CLI schema_migration:
  0001..0019 -> 0020_provider_model_selection -> 0021_official_glm_selection
    -> 0022_backfilled_session_reasoning -> 0023_session_soft_delete_outcome

Host:
  tasks_schema_migration: 0001_adopt_task_schema -> 0002_provider_selection
    -> 0003_official_glm_selection -> 0004_project_execution_scopes
  schema_migration: 0005_projects
```

Upstream historical SQL, checksum inputs and journal shape are kept. This branch's old IDs
`0020_session_soft_delete_outcome` and `0001_projects` are historical aliases of the new IDs: after the old checksum
is verified the completed result is reused without re-running the conversion, and the old records stay for old code
to recognize. New databases still run upstream steps first, then this branch's. The alias exists only for this
development branch's ID shift and must not be used to ignore checksum changes. Any failing step must not open
business writers.

`touchedTables` declares the tables each migration may modify and is used by backup and per-table boundary tests; a
missing, empty or invalid declaration is rejected before any SQL runs. Upstream CLI 0020 declares
`message/part/session_entry`, 0021 and 0022 declare `session_entry`, 0023 declares `session`. Host task migrations
also use the shared runner's table-level backup and per-database-path serial admission, keep the existing checksum
and columns of `tasks_schema_migration`, and put no project column into the frozen historical schema. Backup restore
uses each journal and must not restore business data while keeping a "migration done" record.

The CLI keeps exclusive ownership of session facts, content, soft delete and results; the Host keeps exclusive
ownership of project membership and organization state. The two Host journals are only compatibility bookkeeping and
create no dual-written business state. Host 0004 moves this branch's existing automation/off-peak project execution
directory columns after the upstream task migration so a standalone Repo works; it creates no projects and assigns no
membership. 0005 is still executed by the TaskIndexRepo that receives settings.

## Behavior the merge must preserve

- The project tree and real-roots config directories remain the current design; the old Group/workspace sidebar is
  not restored.
- Project entries are persisted by the Host and tabs only navigate; settings never revive removed entries.
- The remote handshake keeps this branch's member commit and cancellation checks and integrates upstream RPC dispose,
  close-during-handshake validation, close handling by connection identity, unified reconnect at the publish point
  and stable Source identity.
- The shared protocol registers both the project workspace preparation message and the resource snapshot message.
- Drafts save both projectId and initializeFromNewTask; user-scope config uses the base host.
- The storage-migrate dedicated entry does not depend on provider refresh or tool runtime preparation.

```text
handshake -> member/cancel/close checks -> sole Source owner publishes -> services generation change
           | failure                          | reconnect
           v                                   v
     reclaim unpublished connection     notify only one valid publish

desktop-continuous -> same Host/CLI direct live stream
web-remote-replayable -> shared-host attachment -> snapshot/gap recovery
```

## Verification scenarios

1. A common old CLI database, a database already upgraded by this branch, one upgraded by upstream and a new database
   all complete in the new order; old IDs only convert bookkeeping, content/soft delete/results are kept, and repeat
   runs change nothing.
2. Host upstream task schema runs before the project schema; existing project IDs/membership/order are not rebuilt;
   old and new journals coexist, old checksums are unchanged, automation and off-peak fields read/write.
3. A missing touchedTables, checksum mismatch or failed migration leaves business tables untouched; table-level
   backup covers the tables actually written and restore cleans the correct journal.
4. The existing handshake cancel, manual reconnect, multi-profile / same-path isolation, project-entry removal and
   desktop/mobile interaction E2Es from both sides are kept and run; only old locators move, no scenario is deleted.
5. Run the schema gate, architecture check, typecheck, lint and affected tests. Real database operations, pushing and
   MRs were outside this authorization.

WCP01 is verified with the current project design: create a local project with a root through the UI and delete it,
assert the database soft delete; on a full restart, even with an old settings snapshot of the same directory, the
project must not be imported again or revived. VP28 also checks both Host journals, confirming the upstream and
execution-directory migrations complete before the project migration.

## Merge record

Original branch HEAD `00d7538a0e44d79c4dbe5ddc4e5c609233eb8057`; merge target fixed at
`243b87c2c01ea4da6b5b6b6bdd71c4fab8e54528`; a protection branch was created first and 37 text conflicts were
resolved in place. All historical checksums of upstream's 22 CLI and 3 Host migrations match; this branch's renumbered
CLI migration has the same SQL/checksum and the project migration keeps the frozen-checksum test. Final targeted runs
(SQLite/Repo/drafts, project and membership, remote handshake/WebSocket/Registry/Main attachment, CLI storage/model
migration/cold resume, UI restore/config routing/identity/drafts, the storage-migrate entry, and desktop E2E VP28 +
WCP01 under an isolated HOME) passed; `pnpm typecheck`, CLI typecheck, `pnpm lint`, `pnpm db:schema:check`,
`pnpm architecture:check --changed` and `pnpm test:architecture` passed with 0 new violations. New restore only
persists `lastActiveWorkspace` so old settings cannot revive navigation.

Limits: real SSH/WSL/Docker devices were not connected end to end; remote-control conclusions are limited to the
simulated protocol regressions; the full repo test suite and a complete feature-boundary codegraph scan were not run;
no app upgrade was started on a real data directory, no user database was modified, and nothing was pushed or
merged as an MR.
