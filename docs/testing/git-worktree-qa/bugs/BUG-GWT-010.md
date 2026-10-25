# BUG-GWT-010: the executionWorktree fact is not persisted in tasks-index; after a restart sessions of closed workspaces lose the worktree marker and the Environment=Worktree classification

- Status: FIXED (fix wave 2, 2026-10-18: unit + live confirmed in RT2; marker removed)
- Severity: S3 (marker/classification wrong until the workspace is reopened; workaround: open the workspace; sessions, history and git unaffected)
- Cases: F7, I1
- Environment: macOS 27.2, commit `bd6a05b3b7dd045d10a47bc7a193a27f86e8f355` (branch `qa/git-worktree-20261017`), isolated QA instance (production build)

## Repro

1. Fixture R1 (`basic`) per QA-PROMPT §4; QA app started per §2.7, project `basic` open.
2. Create a worktree session: Command Center -> "New task in worktree" (or the Worktree toggle in the composer) -> send a message; wait for ready. The sidebar shows the worktree marker (svg aria `Worktree session · <dir>`); Settings -> Sessions: Branch=`zcode/<name>`, Environment=Worktree.
3. Make sure the worktree's workspace (or the parent workspace listing the session) is closed afterwards (tab closed; that workspace's host not running).
4. Fully restart the QA app (QA-PROMPT §9, then §2.7).
5. Without opening that workspace: the sidebar (Group) shows no worktree marker; Settings -> Sessions shows Branch=`—`, Environment=Local (the Environment=Local filter now includes the session, the Worktree filter does not).
6. Reopen the workspace: the host starts, sessions-index is cold-seeded from the session store (`execution_directory`), and marker plus Branch/Environment return.

Persistence check in the sandbox DB:

```bash
sqlite3 "$QA_ROOT/home/.zcode/v2/tasks-index.sqlite" \
  "SELECT task_id, meta_json LIKE '%executionWorktree%' FROM tasks ORDER BY created_at"
# no worktree session has the executionWorktree key in meta_json (0)
```

## Expected

- `specs/worktree-icon-visibility.md` Decisions 3-5: the sidebar marker renders from the session fact `task.executionWorktree` (healthy/missing are the only states); the fact belongs to the session, not to host liveness.
- `specs/manage-sessions-table.md` §3 (client-side Environment filter by presence of `executionWorktree`) and §4 cols 7-8 (Branch=`executionWorktree.branchName`, Environment=`Worktree` by presence): classification must reflect the session fact; after a restart without opening the workspace it degrades to Local/`-`.
- The row contract implies it: `WindowHostControllerTaskRow.meta.executionWorktree` (`packages/shared/src/zcode-protocol-v4/controller.ts:105`), and `ZCodeTaskMeta.executionWorktree` is declared as "Mirrors the sessions-index sessionSummary field" (`packages/shared/src/zcode-task-types-core.ts:367-372`), so persisted meta must carry the fact like the sibling mirrors (`sideChatCount`, `cronAutomationId`).

## Actual

- F7: after restart the session of case C9 (workspace `detached`, worktree `zcode-grumpy-cookie`, folder on disk, branch @5632c228) lost its sidebar marker; Settings -> Sessions showed Environment=Local, Branch=`—`. Recovery proven: `qa-open detached` restores marker, Branch=zcode/grumpy-cookie, Environment=Worktree.
- SQLite (F7): NO worktree session has the `executionWorktree` key in `meta_json`: the fact is never written, not "lost on overwrite".
- I1 (full restart): right after start only the freshly reopened `detached` workspace's session had the marker; after `qa-open basic` markers returned for all 10 basic worktree sessions. No sessions lost (16/16), git unchanged: a display-classification defect only.

## Cause (confirmed, four links)

1. The live fact exists only on the sessions-index channel: the CLI publishes `executionWorktree` in summaries (`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts:1285` `resolveIndexMeta`; `sessions-index-projection.ts:119`); Desktop receives it via `WindowHostSessionsIndexObserver` -> `sessionOverlay()` (`packages/services/src/window-controller/windowHostControllerService.ts:103`) -> live projection row (`windowHostControllerProjection.ts:174`: `executionWorktree` comes ONLY from `overlay`, never from `membership.meta`).
2. `listTaskList` merges the fact only from the live projection: `windowHostControllerService.ts:613-617` (search path, `projected.executionWorktree`) and `:669-672` (list path, `row.executionWorktree`); the persisted part (`normalized`/`row.meta` from tasks-index) supplies none. `refreshSource` `:452-453` documents the design: "Live facts remain in Host memory only"; the overlay comes from `sourceLiveOverlays` (`:453`) and is empty for a workspace without a running host.
3. Nothing writes the fact: the only `meta_json` writer is `TaskIndexRepo.syncTaskMeta` -> `serializeMetaJson` (`packages/services/src/session/taskIndexRepo.ts:1626`, `:266-268`); all callers build meta without it (`buildMetaFromSnapshot` in `zcodeTaskIndexSyncer.ts:1838-1888`, call `:1704`; `zcodeTaskServiceAdapter.ts:1525`). The snapshot source has no such field: `zcodeSessionStateSnapshotSchema` (`packages/shared/src/zcode-protocol/index.ts:1362-1382`) and `ZCodeAgentCreateSessionParams` (`packages/services/src/zcode-agent/zcodeAgent.ts:223-239`) lack `executionWorktree`.
4. Even a manual write would not be read: `rowToMeta` parses `meta_json` via `zcodeTaskMetaSchema` (`taskIndexRepo.ts:213`; `packages/shared/src/validation.ts:1703-1777`), which has no `executionWorktree`/`executionWorktreeMissing`; zod strips unknown keys. The TS interface declares the field (`zcode-task-types-core.ts:372`) but the runtime persistence contract was not extended.

## Fix direction (no protocol change)

Make the fact a persistent tasks-index property modeled on `cronAutomationId`/`offPeakTaskId` (`meta_json` is the source of truth, preserve-on-absent on later runtime syncs):

1. `packages/shared/src/validation.ts`: add `executionWorktree` (reuse `zcodeExecutionWorktreeSchema`) and `executionWorktreeMissing` to `zcodeTaskMetaSchema`; `rowToMeta` returns them via the `parsed.data` spread.
2. Write the fact at the Host boundary when it is known: when sessions-index summaries arrive (where `sessionOverlay` is built / in the syncer at `syncTaskMeta`), so the existing v4 sessions-index is the channel.
3. In the merge, read the fact as a fallback from persisted meta when the overlay is absent: `windowHostControllerProjection.ts` `buildSourceRows` (spread from `membership.meta`) and/or `windowHostControllerService.ts:613-617,669-672`.

## Test

`packages/services/test/taskIndexWorktreeFact.test.ts` (services level, no UI): real `TaskIndexRepo` on temp sqlite + `createWindowHostControllerRuntime`; the live phase delivers the fact via a sessions-index snapshot frame, then "restart": fresh repo + fresh runtime without an agent service (closed workspace); the cold `listTaskList` must return `executionWorktree`. No sleeps, only the agent-service RPC surface is mocked. Test name: `BUG-GWT-010: cold listTaskList after a restart keeps the worktree session fact` (was `it.fails`; red without marker at the cold assertion `expected undefined to deeply equal {...}`).
