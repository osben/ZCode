# Pane session restore wins over the remembered draft intent

## Background

On a renderer reload (or a desktop startup restore), two owners try to decide what a
workspace pane shows:

- `usePaneSessionPersistence` restores the session the pane was showing
  (`zcode-v4-last-session:v1:<workspaceKey>`), but only while the workspace has no
  explicit draft focus (`draftFocusVersion === 0`).
- `Root` `restoreDraftIntents` restores the project scope of a new-task draft that
  `rememberComposerWorkspaceScope` recorded when the user started a task from a project.
  It calls `startDraft`, which bumps `draftFocusVersion`.

The draft intent is never cleared when that draft becomes a session. After a reload,
`restoreDraftIntents` ran first, bumped `draftFocusVersion` to 1, and the pane restore
then saw a draft focus and dropped the persisted session: a running conversation came
back as an empty draft. Evidence (E2E `conversation-session-v4-vertical-slice`, Node
agent, diagnostic run): `restoreDraftIntents startDraft` at 10:19:05.446, then the pane
mount at 10:19:05.469 with `rendererReload: true`, `draftFocusVersion: 1`,
`stored: {sessionId: S}`.

The logic is identical in upstream 3.17.2. The fork reaches it on every project
workspace because the fork does not seed the default project from settings (ISSUE-024),
so every task starts from a project-scoped draft.

## Product rule

A workspace whose pane will restore its persisted session restores that session, and the
remembered draft intent for the same workspace key (`workspaceIdentity?.trim() ||
workspacePath`) is skipped. The pane restores only for the active tab, and only on a
renderer reload or a desktop startup restore (`tab.restorePaneSession`); the skip uses the
same eligibility (`willRestorePersistedPaneSession`). Inactive tabs, and a pane that was on a
draft (the persistence effect writes `null`), restore their draft intent as before.

A persisted session that no longer exists is dropped by the pane lookup, which falls back to
an unscoped draft; the remembered project scope is not re-applied in that case.

## Owners and event order

```text
renderer reload
  -> Root restorePersistedSession
     -> restoreWorkspaceTabs
     -> restoreDraftIntents, per workspace tab:
          activeTaskId or draftProjectId set   -> skip
          willRestorePersistedPaneSession     -> skip (pane owns the restore)
            (active tab, reload or startup restore, stored session)
          remembered scope                     -> startDraft (draftFocusVersion++)
  -> WorkspaceShellLayout mounts
     -> usePaneSessionPersistence restore effect
          draftFocusVersion === 0 && stored     -> selectSession(stored)
```

## Acceptance

- Unit (fork manifest, `packages/ui/test/paneSessionDraftIntentPrecedence.test.ts`):
  `willRestorePersistedPaneSession` reads the identity key, falls back to the path, is false
  after the pane returns to a draft, and is true only for the active tab on a reload or a
  startup restore.
- E2E: `conversation-session-v4-vertical-slice` restores the streaming session after
  `browser.refresh()` on the Node agent.
