# UI upstream sync (3.16.1) — UI-1 structural base

Takes upstream v3.16.1 (`0a1fc56d`, base `aac47556` = v3.15.1) into `packages/ui`. Branch
`claude/upstream-sync-ui-1`, based on `claude/upstream-sync-services-hard-c` (#204) with
`origin/integration` merged in; the merge was clean. `.staged-file-size-exemptions` contains each
`# TEMPORARY upstream 3.16.1 sync` block once (the shared-package block is listed once).

## Goal of UI-1

Take the upstream project-centric sidebar structure (`packages/ui/src/project-sidebar/`, the
rewritten `app-shell/WorkspaceShellLayout.tsx`, the remote/source-server registries, contract module
directories, composer rewrite) and make `pnpm typecheck` green. Fork features attached to deleted or
rewritten modules are recorded in the ledgers below and re-applied in later UI PRs. i18n
reconciliation is a later PR.

## Method

Overlay, not a three-way merge; reversible via git, base = merge commit `9c2434f7`:

1. `git checkout 0a1fc56d -- packages/ui` wholesale: upstream adds and modifies win; fork edits in
   both-modified files are replaced by upstream and recoverable via
   `git show 9c2434f7:<file>` / `git diff aac47556 9c2434f7 -- <file>`.
2. `git rm` of the 94 upstream-deleted files the fork never edited.
3. The 147 upstream-deleted files the fork edited stay on disk and are ledgered (see below).

Static import audit (TypeScript compiler API; upstream `packages/ui` against HEAD `packages/shared`
and `packages/services`):

- 9 upstream UI files use `window.zcode` directly; they must go through `IPlatformService`.
- 16 upstream files import relay-v2-style types (`@zcode/shared` + relay identifiers), including
  `WorkspaceWebRemoteControlTrigger.tsx`, `hooks/useWebRemoteControlStatus.ts`,
  `web-remote-control/WebRemoteControlDialog.tsx`, `plugin-ui/adapters/messagePortTransport.ts`,
  `project-sidebar/ProjectSidebarNavigation.tsx`, `root/types.ts`, `root/useRemoteWorkspaceHistory.ts`,
  `store/composerAttachmentUploadStore.ts`, `v4/agentConversationTransport.ts`,
  `v4/agentSessionsIndexTransport.ts`, `v4/transport.ts`. Blocked on the relay v1/v2 product
  decision.
- 31 named imports were missing from HEAD `@zcode/services` / `@zcode/shared`
  (`ISourceServerManagementService`, `VirtualProject`, `ProjectTree`, `ProjectTask`,
  `withPluginTelemetry`, `RemoteProjectHost`, `RemoteProjectDirectory`, `OnboardingSettingsSyncPatch`,
  `ILegacyTaskService`, `WebRemoteControlMobileTaskView`, `isWebRemoteControlBridgeableWorkspaceTarget`,
  `WindowHostTaskUnreadSignal`, `ZCodeWorkspaceStateSnapshot`). UI-1 cannot compile until the
  services/shared PRs provide them; adding them by hand into UI is forbidden (the UI must not own
  services or protocol types).

## Ledger

Fork features that lived in upstream-deleted or rewritten modules, with re-apply targets:
`specs/ui-upstream-sync-ledger.md` (deleted-but-fork-edited rows, typecheck buckets) and
`specs/ui-upstream-sync-ledger-2.md` (upstream-owned error files and window.zcode rule violations).
Known candidates: sidebar polish and hover actions (`sidebar-ui-polish.md`), sidebar child counts
(`sidebar-child-conversation-counts.md`), incognito marker (`incognito-session.md`), archive confirm
guards (`ui-accidental-action-guards.md`), SettingsPage sections (`system-prompt-settings.md`,
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
