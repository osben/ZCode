# Settings "Show in sidebar" does not focus the project

Status: ready-for-human

Baseline `d31e735905cf744e75a0a93548a80acabe871ae5`, test patch 07, batch
`r3-server-20261011125749338-152f05`; `settings-safeguards` failed after 153.1 s.

With a real SSH project connected, device card "More → Show in sidebar" returns to the main view but, for
10 s, never hands focus to the project. The test already reads the focused project through the current
`data-project-workspace-identity`; this is not a stale test selector.

`SettingsPage.tsx` `onShowInSidebar` still queries `[data-remote-project-identity]` /
`dataset.remoteProjectIdentity` and focuses its `[role="button"]`. The current `ProjectNode.tsx` renders
`data-project-workspace-identity`, and the project title is a native button with
`data-testid="virtual-project-toggle"`. The old query finds no project row, so scrolling and focusing never
run.

The [device settings contract](../../architecture/remote-device-connection-ux-spec.md) requires this action
to locate the existing project regardless of device online state; it should use the current project entry
identifier and focusable control. Business code is unchanged and the locate/focus assertions are kept. The
later remove-confirmation step runs after this failure and is not yet covered.

Evidence: `packages/desktop/.e2e-artifacts/r3-server-20261011125749338-152f05-settings-safeguards/`.
