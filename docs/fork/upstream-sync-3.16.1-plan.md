# Upstream sync record: v3.15.1 (`aac47556`) to v3.16.1 (`0a1fc56d`)

Status: FINAL RECORD. The sync is merged into `integration` through PR #228 (merge commit `cccf1977`). Full history: `git show fcfed95d:docs/fork/upstream-sync-3.16.1-plan.md`.

Start point: fork `integration` before the sync, base `aac47556` (upstream v3.15.1). Target: upstream `0a1fc56d` (v3.16.1). Pin: `fork-upstream-base.json` = `0a1fc56d` / `3.16.1`. Root version `3.16.1-fork.1` (see `specs/fork-release-versioning.md`).

## 1. Merged PRs

Merged into `integration` between 10-18 and 10-20 (UTC), in order:

- Tooling first: #144 (fork-format-scope: `fmt` and `fmt:check` limited to fork-changed files since the upstream base), #185 (fmt exempts files identical to a pending upstream commit), #191 (CI fetches the pending upstream commit in the unit-tests job).
- Layered upstream port: #186 (docs byte-copy), #187 (safe deletions), #188 (tooling and workspace wiring), #189 (shared layer), #192 (leaf packages), #196 and #197 (database layers), #200, #202 and #204 (services), #201, #203, #206, #208, #209 and #211 (`apps/zcode-cli` slices), #210 (desktop part 1), #215 (UI-1), #205, #213, #214, #216 to #220, #222 to #224 (server-cli, desktop parts 3 and 4, API exports, UI-2a and UI-2b, web, leftovers, size-guard exemptions, static path containment, big-bang merge).
- Fixes during the port: #198 (bot polling and storage init under lock contention), #212 (build alias, storage-migrate result), #221 (pnpm 12.14.0 and workspace build pipeline).
- Decisions and tests: #225, #226 (owner model and services decisions), #227 (model switch keeps input, bugfix audit verdicts).
- Final sync: #228, `chore(sync): merge upstream 3.16.1 (0a1fc56d)`, merge commit `cccf1977`.
- After the sync: #231 (bots adopt `[hostId, projectId]` project identity with persisted-state migration), #230 (affected unit tests on PRs, full suite nightly and on demand), #232 (fork sidebar pins migrated to upstream project pins), #233 (UI parity pass 2), #239 (upstream zh-CN UI tests translated; OFL fonts registered in licenses), #234 (UI parity pass 3b, composer).

Open or unmerged follow-ups (the relay PR, section 5) are not listed.

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
- Next upstream target: `3c5b2276` (upstream `main` moved there during the sync). It is the next sync, not part of 3.16.1. Synced in `specs/upstream-sync-3.16.2.md`.

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
- Next upstream target: `3c5b2276`, synced in `specs/upstream-sync-3.16.2.md`. After that, 3.16.3 (source not yet published).

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
