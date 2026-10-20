# UI upstream sync: fix group G2 (settings, remote, draft, task state)

Scope: failing vitest files of group G2 after the 3.16.1 UI integration (`claude/upstream-sync-ui`, head 9764ff85).

## Settings section list

- `settings/settingsPageConfig.ts`: removed the upstream `remoteDevices` and `archives` entries. The fork lists neither; Data and Statistics is `usage` and `sessions`. `isSettingsSectionAvailable` and `SETTINGS_SECTION_GROUPS` stay exported because `SettingsPage.tsx` imports them.
- `settingsPageConfig.test.ts`: dropped the `remoteDevices` expectations, matching the fork test (`9c2434f7`). The `isSettingsSectionAvailable` case stays.
- Open: `SettingsPage.tsx` still renders the `remoteDevices` branch and `Root.tsx` still sends `setPendingSettingsSectionIntent("remoteDevices")`. Those branches are unreachable from the list. Decide whether to delete them in the UI-2 PR.

## Settings page source assertions

- `SettingsPage.tsx`: two comments restored to the fork English text (the help-menu placement comment and the avatar-menu `isDesktop` comment). `settingsHelpMenuEntry.test.ts` asserts on these strings. Code is unchanged.
- `settingsPageIntegratedTerminalShell.test.ts`: the two upstream tests run effects in the node environment, and `SettingsPage` registers a window listener. Both tests stub `window` with `addEventListener` and `removeEventListener`; `afterEach` unstubs globals. The two tests are not in the fork test file.

## Docker container chooser

- `RemoteConnectionFields.tsx`: the Docker case no longer uses the upstream select/manual segmented toggle. The running-container chooser and the manual container input render together, as in the fork (base) code. Selecting a container does not clear the manual input; the submit path already prefers the manual value (`lib/remoteConnectionWizard.ts`).
- Empty and unavailable Docker hosts show the same short hint (`docker.noContainers`); the `docker.unavailable` key is no longer used here.
- `dockerAvailable` is still a prop, not destructured.
- Size: the file is 46 KB; a `.staged-file-size-exemptions` line was added under the G2 block.

## Draft model hydration

- `v4/composer/useDraftConfigControl.ts`: after the session config block, a draft without a model selection takes the session config's model selection. This fixes a fork child that hydrates mode first and receives its inherited model later. A model already chosen in the draft is kept. Ported from fork `useDraftConfigControl.ts`.

## Highspeed activation test

- `test/highspeed/sessionPaneHighspeedActivation.test.ts`: the services mock gains `projectService.resolveSessionDirectories`. Upstream `SessionPane` resolves the session project before prepare on a recent-submission send; the fork has no such call. The mock returns `{ projectId: null }`.

## Active task state test

- `test/useWorkspaceActiveTaskState.test.ts`: the logger mock exposes `debug`, `info`, `error` as well as `warn`. The sessions-index subscription logs at debug level.
- Not ported: the fork test "preserves the sessions-index worktree on snapshot metadata for an uncached active task" is absent from the current test file. The snapshot fallback (`useActiveTaskSnapshotMeta`) is unused by the hook, as ledger b4 recorded. Needs a decision in the UI-2 PR.

## Still failing

- `test/sshDialogDirectorySelection.test.ts`: collection error. The upstream `SSHDialog` delegates to `remote-connection-flow`, and the fork test mocks the fork wizard modules. Mock surface gaps found so far: `lucide-react` `Server` (via `RemoteConnectionSelection`), `useRemoteBoundaryAcknowledgement`, `createElementNS`, `focus`, `contains`, `querySelector`, base `settingService`. The fake DOM in this file cannot host upstream's `SSHDialog`. The fix needs either a jsdom environment (as `useWorkspaceActiveTaskState.test.ts` uses) or a decision to rewrite this file against `remote-connection-flow`. The containment logic (selecting reset on reject) exists upstream at `remote-connection-flow/index.ts` near lines 1210-1221.
