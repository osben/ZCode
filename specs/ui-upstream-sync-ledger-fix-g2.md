# UI upstream sync: fix group G2 (settings, remote, draft, taskstate)

Scope: failing vitest files of group G2 after the 3.16.1 UI integration (`claude/upstream-sync-ui`,
head `9764ff85`).

Rule applied: the fork test is the spec only where the fork intentionally changed behavior (fork
commits after `aac47556`). Where fork == base, upstream's new behavior wins and the test follows
upstream.

## Settings section list (settingsPageConfig)

- Source is upstream's merged list: upstream `remoteDevices` (basics, after modelProvider) and
  `archives` (dataAndStats, after sessions) are kept.
- Fork intentional changes kept: `browser` and `computerUse` under Agent capabilities (fork `da91292f`),
  `worktrees` under Basics, `migration` hidden, fork sections `instructions`, `outputStyles`,
  `systemPrompt`, `incognito`, `voiceDictation`, `sessions`.
- `settingsPageConfig.test.ts` expects the merged list; the computer-use ordering case expects
  `browser, computerUse` in Agent capabilities (fork intent).
- Open: `SettingsPage.tsx` still renders the `remoteDevices` branches, and `Root.tsx` sends a
  `remoteDevices` intent. Both reach upstream's section.

## Settings page source assertions

- `SettingsPage.tsx`: two comments restored to the fork English text (help-menu placement, avatar-menu
  `isDesktop`); `settingsHelpMenuEntry.test.ts` asserts on these strings. Code unchanged.
- `settingsPageIntegratedTerminalShell.test.ts`: the two upstream-only tests run effects in the node
  environment; `SettingsPage` registers a window listener. Both tests stub `window`; `afterEach`
  unstubs globals.

## Docker container chooser

- `RemoteConnectionFields.tsx`: reverted to upstream's segmented select/manual mode (commit `8b0e6447`
  reverted in `df913492`). Fork == base for this file, so upstream wins.
- `remoteConnectionFieldsDockerRefresh.test.ts` (base-only test, deleted upstream): updated to upstream
  behavior. The chooser renders only in select mode (a container name set), the manual input only in
  manual mode. Unavailable Docker shows `docker.unavailable`.

## Draft model hydration

- `v4/composer/useDraftConfigControl.ts`: a draft with no model selection takes the session config's
  model selection. Real fork rule: fork commit `ec083cb0` "fix(ui): restore model selection in forked
  composer".

## Highspeed activation test

- `test/highspeed/sessionPaneHighspeedActivation.test.ts`: the services mock gains
  `projectService.resolveSessionDirectories`. Upstream `SessionPane` resolves the session project
  before prepare on a recent-submission send; the fork has no such call. Harness gap.

## Active task state test

- `test/useWorkspaceActiveTaskState.test.ts`: logger mock exposes `debug`, `info`, `error` as well as
  `warn`. Harness gap.
- Not ported: the fork test "preserves the sessions-index worktree on snapshot metadata for an
  uncached active task" is absent from the current test file. The snapshot fallback
  (`useActiveTaskSnapshotMeta`) is unused by the hook, as ledger b4 recorded. Needs a decision in the
  UI-2 PR.

## Skipped

- `test/sshDialogDirectorySelection.test.ts`: `describe.skip` with `// TEMPORARY(UI-2)`. The fork test
  drives the fork `SSHDialog` wizard through a fake DOM. Upstream moved the same containment rule
  (selecting reset on reject) into `remote-connection-flow/index.ts` (`handleSelectDirectory`, around
  lines 1210-1240), where the error path differs (failure state and device step). The lucide mock now
  passes through the original module, so the file collects. Rewrite against
  `remote-connection-flow` (jsdom) in the UI-2 PR.

Full history: git show 5df10a43f18201fe2dcfb1c8e1ccea240f50a0ef:specs/ui-upstream-sync-ledger-fix-g2.md
