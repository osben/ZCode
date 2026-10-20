# UI upstream sync (3.16.1) — UI-1 structural base

Status: DRAFT, in progress. Target upstream commit `0a1fc56d` (v3.16.1), base `aac47556` (v3.15.1).
Branch `claude/upstream-sync-ui-1` is based on `claude/upstream-sync-services-hard-c` (#204) with
`origin/integration` merged in. The merge was clean; `.staged-file-size-exemptions` contains each
`# TEMPORARY upstream 3.16.1 sync` block once (the shared-package block is listed once).

## Goal of UI-1

Take the upstream project-centric sidebar structure (`packages/ui/src/project-sidebar/`, the
rewritten `app-shell/WorkspaceShellLayout.tsx`, the remote/source-server registries, contract
module directories, composer rewrite) and make `pnpm typecheck` green. Fork features that were
attached to deleted or rewritten modules are recorded in the ledger below and re-applied in later
UI PRs. i18n reconciliation is a later PR.

## Measured scope (static, `git diff --name-status aac47556 0a1fc56d -- packages/ui`)

Classified against fork changes (`aac47556..HEAD`, path-level):

| Upstream change | Fork untouched | Fork touched |                                           Total |
| --------------- | -------------: | -----------: | ----------------------------------------------: |
| Added (A)       |            389 |            0 |                                             389 |
| Modified (M)    |            217 |          585 |                                             802 |
| Deleted (D)     |             94 |          147 |                                             241 |
| Renamed (R\*)   |             19 |            0 | 19 (approx.; rename-target matched by new path) |

Under `packages/ui/src` and excluding tests: 203 added, 36 modified fork-untouched, 335 modified
fork-touched, 12 deleted fork-untouched, 43 deleted fork-touched.

## Static import audit (not a typecheck)

Script inputs: upstream `packages/ui` (`git archive 0a1fc56d`), HEAD `packages/shared` and
`packages/services`. It parses imports with the TypeScript compiler API.

- Relative imports with a missing upstream target: 1 (a manual-review fixture referencing
  `config/provider/zcode-builtin.json` through a relative path that exists only in a different
  layout; check when porting that test).
- `window.zcode` users in upstream `packages/ui/src`: 9 files (must go through `IPlatformService`).
- Upstream UI files that import relay-v2-style types (`@zcode/shared` + relay identifiers): 16 files.
  Left untouched by this PR: `WorkspaceWebRemoteControlTrigger.tsx`, `hooks/useWebRemoteControlStatus.ts`,
  `web-remote-control/WebRemoteControlDialog.tsx`, `web-remote-control/domain/presentation.ts`,
  `plugin-ui/adapters/messagePortTransport.ts`, `plugin-ui/app/pluginUiAppTools.ts`,
  `project-sidebar/ProjectSidebarNavigation.tsx`, `project-sidebar/index.tsx`, `root/types.ts`,
  `root/useRemoteWorkspaceHistory.ts`, `store/composerAttachmentUploadStore.ts`,
  `v4/agentConversationTransport.ts`, `v4/agentSessionsIndexTransport.ts`, `v4/transport.ts`,
  and the test `test/projectSidebarHomeOnlyWorkspaces.test.ts`. These are blocked on the relay v1/v2
  product decision.

### Named imports missing from HEAD `@zcode/services` / `@zcode/shared` (31 usages)

| Name                                                                            | Module   | Usages | Interpretation                                                           |
| ------------------------------------------------------------------------------- | -------- | -----: | ------------------------------------------------------------------------ |
| `ISourceServerManagementService`                                                | services |     12 | services source-server-management work not yet on this branch            |
| `VirtualProject`                                                                | services |      4 | upstream services export missing on HEAD                                 |
| `ProjectTree`                                                                   | services |      2 | upstream services export missing on HEAD                                 |
| `ProjectTask`                                                                   | services |      2 | upstream services export missing on HEAD                                 |
| `withPluginTelemetry`                                                           | services |      2 | upstream services export missing on HEAD                                 |
| `RemoteProjectHost`, `RemoteProjectDirectory`                                   | services |      2 | upstream services export missing on HEAD                                 |
| `OnboardingSettingsSyncPatch`                                                   | services |      1 | upstream services export missing on HEAD                                 |
| `ILegacyTaskService`                                                            | services |      1 | not exported upstream either (likely a stale import in an upstream test) |
| `WebRemoteControlMobileTaskView`, `isWebRemoteControlBridgeableWorkspaceTarget` | shared   |      3 | relay v2 surface (deferred in #189)                                      |
| `WindowHostTaskUnreadSignal`, `ZCodeWorkspaceStateSnapshot`                     | shared   |      2 | upstream shared additions deferred in #189                               |

Consequence: UI-1 cannot compile until the services and shared surface named above exists on this
branch. Adding them by hand into UI is forbidden (AGENTS.md: the UI must not own services or
protocol types). The next step is to pull these exports through the services/shared PRs.

## Method and status

Baseline `pnpm typecheck` on the merged branch state passes (exit 0, zero `error TS`).

Overlay (applied on this branch, reversible via git, base = merge commit 9c2434f7):

1. `git checkout 0a1fc56d -- packages/ui` (wholesale: upstream adds and modifies win; fork edits in
   both-modified files are replaced by upstream, and their deltas are recoverable from
   `git show 9c2434f7:<file>` / `git diff aac47556 9c2434f7 -- <file>`). This is a take-upstream rule,
   not a three-way merge; no `merge-file` was run.
2. `git rm` of the 94 upstream-deleted files that the fork never edited.
3. The 147 upstream-deleted files that the fork edited remain on disk and are ledgered below.

Typecheck after the overlay (`pnpm typecheck`, exit 2, 513 errors). Blockers listed in the section
"Typecheck buckets" below. Services/shared exports from branch `claude/upstream-sync-api-exports`
are not merged yet.

## Ledger (fork edits in upstream-deleted or structurally rewritten files)

Columns: file, fork feature, where to re-apply. Known candidates from `git log aac47556..HEAD -- packages/ui`
and `specs/*.md`: sidebar polish and hover actions (`sidebar-ui-polish.md`), sidebar child counts
(`sidebar-child-conversation-counts.md`), incognito marker (`incognito-session.md`), archive
confirm guards (`ui-accidental-action-guards.md`), SettingsPage sections (`system-prompt-settings.md`,
`voice-dictation.md`, `themes.md`), turn navigator pin highlight (`turn-navigator-pin-highlight.md`),
merged-session highlight (`merged-session-highlight.md`), manage-sessions table
(`manage-sessions-table.md`), memory viewer v2 (`memory-viewer-v2.md`), token throughput
(`session-token-throughput.md`), workspace sidebar customization (`workspace-sidebar-customization.md`).

## Deferred

- UI-1c: services-side grouped task view switch (`ZCodeGroupedTaskView`, `zcodeTaskService*`,
  `task-groups/repository.ts` owner, `onDynamicTaskUnreadSignal` producer). Starts only after the UI
  structure typechecks. Not started.
- i18n reconciliation of fork keys (en-US and zh-CN take upstream in a later PR; uk-UA is stale).
- Compat shims for web and desktop consumers of removed UI exports: none added yet.

## Ledger and buckets

See `specs/ui-upstream-sync-ledger.md` (deleted-but-fork-edited rows, typecheck buckets) and `specs/ui-upstream-sync-ledger-2.md` (upstream-owned error files and window.zcode rule violations).
