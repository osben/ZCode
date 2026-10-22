# Upstream sync record: v3.15.1 (`aac47556`) to v3.16.1 (`0a1fc56d`)

Status: FINAL RECORD. The sync is merged into `integration` through PR #228 (merge commit `cccf1977`). This file replaces the earlier draft plan. Later fixes are listed in the PR table below.

Start point: fork `integration` before the sync, base `aac47556` (upstream v3.15.1). Target: upstream `0a1fc56d` (v3.16.1). Pin: `fork-upstream-base.json` = `0a1fc56d` / `3.16.1`. Root version `3.16.1-fork.1` (see `specs/fork-release-versioning.md`).

## 1. PR table (merged, sync-related, merge order)

Source: `gh pr list --repo osben/ZCode --state merged`, sorted by merge time (UTC). Same-minute merges are grouped on one line.

| Order | Merged (UTC) | PR                                                               | Content                                                                                                                                                                                                                                                  |
| ----- | ------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | 10-18 16:39  | #144                                                             | fork-format-scope: fmt and fmt:check limited to fork-changed files since the upstream base                                                                                                                                                               |
| 2     | 10-20 01:07  | #185                                                             | fmt: exempt files identical to a pending upstream commit                                                                                                                                                                                                 |
| 3     | 10-20 04:34  | #186                                                             | docs: byte-copy of 280 untouched upstream docs (PR 1/N)                                                                                                                                                                                                  |
| 4     | 10-20 04:35  | #187                                                             | chore: 6 safe upstream deletions (PR 2/N)                                                                                                                                                                                                                |
| 5     | 10-20 05:07  | #191                                                             | ci: fetch the pending upstream commit in the unit-tests job                                                                                                                                                                                              |
| 6     | 10-20 05:32  | #188                                                             | chore: upstream tooling and workspace wiring (PR 3/N)                                                                                                                                                                                                    |
| 7     | 10-20 05:49  | #189                                                             | feat(shared): upstream shared layer (PR 4/N)                                                                                                                                                                                                             |
| 8     | 10-20 06:43  | #192                                                             | feat: upstream leaf packages (PR 5/N)                                                                                                                                                                                                                    |
| 9     | 10-20 06:48  | #196                                                             | feat(services): upstream database layer (PR 7a)                                                                                                                                                                                                          |
| 10    | 10-20 13:30  | #197, #201, #203, #206                                           | feat(cli): session-store database layer (PR 7b); apps/zcode-cli slices 1, 2, 3 (bootstrap)                                                                                                                                                               |
| 11    | 10-20 15:09  | #200                                                             | feat(services): upstream services (PR 8a/8b)                                                                                                                                                                                                             |
| 12    | 10-20 15:32  | #202                                                             | feat(services): host assembly and settings (PR 8b)                                                                                                                                                                                                       |
| 13    | 10-20 15:33  | #204, #208, #209, #211                                           | feat(services): hard files (PR 8c); apps/zcode-cli slices 4a, 4b, 4d                                                                                                                                                                                     |
| 14    | 10-20 15:34  | #212                                                             | fix(cli): follow-ups (build alias, storage-migrate result)                                                                                                                                                                                               |
| 15    | 10-20 16:09  | #210                                                             | feat(desktop): upstream desktop (part 1)                                                                                                                                                                                                                 |
| 16    | 10-20 16:18  | #198, #221                                                       | fix: bot polling and storage init under lock contention; pnpm 12.14.0 and workspace build pipeline                                                                                                                                                       |
| 17    | 10-20 16:37  | #215                                                             | feat(ui): upstream packages/ui structure and fork re-application (UI-1)                                                                                                                                                                                  |
| 18    | 10-20 17:58  | #205, #213, #214, #216, #217, #218, #219, #220, #222, #223, #224 | server-cli (PR 6); desktop part 3 and part 4; services and shared API exports; UI-2a and UI-2b; web (non-relay); services leftovers; size guard exempts test and md files; static path containment and buffered terminal output; upstream big-bang merge |
| 19    | 10-20 19:41  | #225, #226                                                       | docs(desktop) group C owner model; services upstream sync part 5 decisions                                                                                                                                                                               |
| 20    | 10-20 19:43  | #227                                                             | test(ui): model switch keeps input; bugfix audit verdicts                                                                                                                                                                                                |
| 21    | 10-20 21:54  | #228                                                             | chore(sync): merge upstream 3.16.1 (`0a1fc56d`), final sync. Merge commit `cccf1977`                                                                                                                                                                     |
| 22    | 10-20 22:42  | #231                                                             | feat(bots): adopt upstream project identity `[hostId, projectId]` with persisted-state migration                                                                                                                                                         |
| 23    | 10-20 23:02  | #230                                                             | ci: affected unit tests on PRs, full suite nightly and on demand                                                                                                                                                                                         |
| 24    | 10-20 23:27  | #232                                                             | UI parity PR1a: fork sidebar pins migrated to upstream project pins                                                                                                                                                                                      |
| 25    | 10-20 23:28  | #233                                                             | feat(ui): upstream parity pass 2 (lib, settings, model selection)                                                                                                                                                                                        |
| 26    | 10-20 23:29  | #239                                                             | test(ui): translate upstream zh-CN UI tests; register OFL fonts in licenses                                                                                                                                                                              |
| 27    | 10-20 23:40  | #234                                                             | feat(ui): upstream parity pass 3b (composer)                                                                                                                                                                                                             |

Notes:

- Open or unmerged follow-ups (the relay PR, see section 5) are not in this table.

## 2. What is in integration now

- Upstream 3.16.1 (`0a1fc56d`) is merged into `integration` via PR #228 (merge commit `cccf1977`).
- The fork pin is `fork-upstream-base.json` = `0a1fc56d` / `3.16.1`. `pendingUpstreamCommit` is removed.
- Fork features re-applied on top of upstream: pins (migrated to upstream project pins), incognito sessions, worktree sessions and composer semantics, voice dictation, usage statistics, Git/worktree fixes, bots `/remote`, and the self-hosted relay on the relay v2 decision (see section 3).
- Upstream UI structure (`project-sidebar/`, the upstream composer and settings) is the base; fork behavior was re-applied in UI-1, UI-2a, UI-2b and the parity passes.
- Tests: UI tests use the en-US copy convention, and the upstream zh-CN UI tests were translated (#239).
- The `ledger` file at `specs/upstream-sync-final-ledger.md` is the WIP-era ledger from before the merge. Its hand-merge counts are historical. Current decisions are in section 3.

## 3. Decisions taken

- Pins: the upstream project pin model is the owner. `fork_workspace_pins` data is migrated into upstream project pins (#232).
- `/plan` slash command: removed in the fork. The upstream palette toggle is used instead.
- Bots: adopt `[hostId, projectId]` project identity (#231). Persisted bot state is migrated, and backups of the old state are kept.
- Relay: the fork relay runs relay v2 with fork-owned JWT keys read from environment variables. The relay V2 migration has landed (`specs/relay-v2-migration.md`, Status line).
- Size guard: `.md` and test files are exempt from the staged-size guard (#222). Other exemptions are temporary and listed in section 4.
- `getTaskMeta` throws when the task source becomes invalid, instead of returning a partial value.
- Build chain: `stageRemoteAssetsCli` is called directly from the build chain, not through the old wrapper.
- Architecture: temporary exception `fork-sync-final-new-files` covers new fork files that the upstream policy does not yet describe. It must be removed when those modules are registered.
- Telemetry: plugin lifecycle telemetry is intentionally off in the fork.
- Earlier decisions still in force:
  - Off-peak/idle-turn Bash keeps the fork guard. A notification turn must not run a full agent loop on the user's plan (`specs/upstream-sync-cli-divergences.md`).
  - Migration `0023` fork worktree columns moved to `9002_fork_session_execution_worktree` with `previousIds` for DBs that already have the fork row (#197). Upstream migration ids and checksums are not changed.
  - Settings: the fork sidecar and per-call HOME are kept, with the upstream projection and CAS layered on top (#202).
  - `independentPlanSupport`: the fork `runtimeCapabilitySupport.ts` is the single owner (#204).
  - Task state: the fork `zcodeTask*` writer stays the single writer. Upstream `task-facts` and `task-groups` stay unwired until the sidebar work is complete.
  - `server/src/http.ts`: `/api/connect-remote` and `/ws/remote/:id` are kept, because fork remote features and bots `/remote` depend on them.
  - `uk-UA` locale is kept. The shared `Locale` stays three-valued, and UI service boundaries map uk-UA to en-US through `toServiceLocale()`.
  - `autoUpdater.ts` keeps the fork "3.15.3 parity" quit-and-install state machine. Upstream's `quitAndInstallState` and `isUpdateTargetLocked()` are not adopted (`specs/desktop-upstream-sync.md`).
  - Relay placeholders are resolved: `WebRemoteControlStatus.mobileTaskView` is nullable and `WebRemoteControlTaskTarget.hostId` is a live optional member. Their TEMPORARY markers were removed in the relay-v1 cleanup.
- Next upstream target: `3c5b2276` (upstream `main` moved there during the sync). It is the next sync, not part of 3.16.1.

## 4. Known gaps and follow-ups

- `CommandCenterDialog`, `SettingsPage`, `Root`, `WorkspaceHeaderSections` and `ModelConfigSelect` are not yet reduced to spec-only hunks. They still carry fork-specific code beyond what the specs require.
- Locales: pruning of unused locale keys is not done.
- `workspace-grouped-tasks` retirement is not done. The grouped task view is replaced by `task-groups` and `project-sidebar` in a later PR.
- `buildTaskListResultFromSessions` and `taskFileTreeTarget` deletion is not done.
- `web-remote` local-global mode was removed by decision (follow upstream). `createRemoteWorkspaceServiceCollection` and its tests are deleted; see `specs/upstream-sync-final-ledger.md` section `local-global collection removal`.
- Compile bridges: temporary bridges added during the sync to keep compilation green. Remove each once its target is wired.
- Temporary size exemptions in `.staged-file-size-exemptions` (each must be split below 20000 bytes, then its block removed):
  - Sync WIP block (`upstream 3.16.1 final sync WIP`):
    - `packages/desktop/src/host/sourceServerConnectionManager.ts`
    - `packages/desktop/src/host/sourceServerDirectory.ts`
    - `packages/desktop/src/host/windowRemoteConnectionRegistry.ts`
    - `packages/desktop/src/main/browserView/browserPlaywrightLocatorExecutor.ts`
    - `packages/desktop/src/main/desktopMainIpcRemote.ts`
    - `packages/desktop/src/main/desktopRemoteSessions.ts`
    - `packages/desktop/src/main/desktopRuntimeEnv.ts`
    - `packages/desktop/src/main/editors.ts`
    - `packages/desktop/src/main/taskRealtimeBus.ts`
    - `packages/server/src/remote/remoteAssetCache.ts`
    - `packages/server/src/remote/ssh-backend.ts`
    - `packages/server/src/remote/wsl-backend.ts`
    - `packages/services/src/conversation-share/conversationShareArtifactDiscovery.ts`
    - `packages/services/src/conversation-share/conversationShareHttpClient.ts`
    - `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts`
    - `packages/services/src/conversation-share/conversationSharePublicProjection.ts`
    - `packages/services/src/conversation-share/conversationShareService.ts`
    - `packages/services/src/session/offPeakMockGateway.ts`
    - `packages/services/src/session/offPeakTaskService.ts`
    - `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`
    - `packages/services/src/zcode-session/zcodeSessionService.ts`
    - `scripts/architecture/upstream-snapshot.json`
    - `architecture-policy.yaml`
  - Composer block (`ui-parity-composer`): the composer keeps fork features required by `specs/composer-worktree-setup-steps.md`, `specs/incognito-session.md`, `specs/voice-dictation.md` and `specs/composer-branch-switcher-semantics.md`. Remove after the composer is split:
    - `packages/ui/src/v4/ConversationComposer.tsx`
    - `packages/ui/src/v4/composer/composerDraftStore.ts`
    - `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`
    - `packages/ui/src/v4/composer/useComposerAttachments.ts`
    - `packages/ui/src/v4/composer/useDraftConfigControl.ts`
  - Fonts block (`ui-tests-fonts`):
    - `third-party/npm-overrides.json` (generated-style license table; remove once split)
- Pre-push unit step skips the root suite. CI is the gate for the root suite until the pre-push step is fixed.
- Shared database safety: `~/.zcode/v2/tasks-index.sqlite` and `~/.zcode/cli/db/db.sqlite` are shared between the upstream build and this fork. Back up `~/.zcode` before running a new build against real data. Fork-owned tables and migrations use the `fork_` and `9001_fork_*` / `9002_fork_*` prefixes.
- Next upstream target: `3c5b2276`.

## 5. Owner tasks

- Register the OAuth redirect `https://zcode.z.ai/remote/v4` with the provider.
- Relay: set the JWT key environment variables required by the fork-owned relay v2. The relay PR that reads them is still pending. Do not deploy the relay until both are in place.
- Fontsource license review is done (PR #239).
- Manual test checklist before the next release:
  - Sidebar: project pins, unpinning, hover actions, unread markers.
  - Drafts: draft survives task switch, restart and worktree failure return.
  - Incognito and worktree sessions: creation, marker, cleanup, retry.
  - Remote sessions and Web remote: connect, reconnect, disconnect, task list.
  - Bots: `/remote` command and re-bind after identity migration.
  - Themes: light and dark, all settings pages.
  - Voice dictation: start, cancel, insert at caret.
  - Share: create and open a shared conversation.

## 6. Reference

- Upstream commit analysis branch (older draft): `claude/upstream-commit-analysis-7443f6`.
- Specs: `specs/fork-release-versioning.md`, `specs/fork-format-scope.md`, `specs/upstream-sync-cli-divergences.md`, `specs/desktop-upstream-sync.md`, `specs/upstream-sync-final-ledger.md`.
